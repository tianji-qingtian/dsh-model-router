import z from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/index.js
/**
* dsh-model-router — host half.
*
* Model Router & Cost Optimizer for DeepSeek Harness.
*
* Quick answers: in `agent/pre-step`, clearly heavy work (strong keywords /
* long payloads) takes the normal flow directly; everything else is judged
* by a zero-prefix flash call (SIMPLE / AGENTIC). SIMPLE requests are
* answered by a zero-prefix flash stream and written straight into the
* session log — the main model never runs for them and its prefix cache is
* never touched. AGENTIC requests (including context-dependent follow-ups)
* take the normal flow.
*
* Fallback: transient failures (RATE_LIMIT / SERVER / TIMEOUT /
* EMPTY_RESPONSE) mark the agent degraded for the turn and return
* `{ kind: 'retry' }`; the retry re-enters `agent/request` and lands on the
* cheap model. At most one degradation per turn; everything else delegates to
* the provider's own retry policy.
*
* Metering: a session projection (`modelRouter`) folds the durable log —
* `request/header` events track the active provider/model and its changes,
* `assistant/message` events accumulate real adapter token usage (including
* cache read/write and reasoning tokens) and an estimated cost from a
* model-class price table. Being a projection, the numbers are replay-safe
* and survive cold sessions.
*
* Manual control: `/router auto|off` slash command and the model-visible
* `route_model` tool toggle quick-answering per session.
*/
const inject = [
	"llm",
	"tools",
	"sessionProjections"
];
const CHEAP_RE = /(flash|chat|mini|turbo|haiku|lite|air|nano)/i;
const STRONG_RE = /(pro|reasoner|opus|sonnet|max|ultra|premium|r1)/i;
/**
* Estimated USD per 1M tokens, matched by model-id class. DeepSeek bills
* cache hits separately from input. Edit freely — the panel labels the number
* as an estimate.
*/
const PRICE_TABLE = [{
	test: CHEAP_RE,
	input: .27,
	output: 1.1,
	cacheHit: .07
}, {
	test: STRONG_RE,
	input: .55,
	output: 2.19,
	cacheHit: .14
}];
const RETRYABLE = [
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"EMPTY_RESPONSE"
];
const modelRecordSchema = z.object({
	calls: z.number(),
	inTokens: z.number(),
	outTokens: z.number(),
	cacheRead: z.number(),
	cacheWrite: z.number(),
	reasoning: z.number()
});
const projectionSchema = z.object({
	mode: z.string(),
	quickAnswers: z.number(),
	lastQuick: z.union([z.null(), z.object({
		seq: z.number(),
		turn: z.string(),
		model: z.string(),
		preview: z.string()
	})]),
	current: z.union([z.null(), z.object({
		provider: z.string(),
		model: z.string()
	})]),
	totals: z.object({
		calls: z.number(),
		inTokens: z.number(),
		outTokens: z.number(),
		cacheRead: z.number(),
		cacheWrite: z.number(),
		reasoning: z.number(),
		cost: z.number()
	}),
	byModel: z.record(z.string(), modelRecordSchema),
	modelChanges: z.array(z.object({
		seq: z.number(),
		provider: z.string(),
		model: z.string()
	}))
});
function priceFor(model) {
	for (const row of PRICE_TABLE) if (row.test.test(model)) return row;
	return null;
}
function usageCost(model, usage) {
	const price = priceFor(model);
	if (!price) return 0;
	const input = usage.inputTokens || 0;
	const output = usage.outputTokens || 0;
	const cacheRead = usage.cacheReadTokens || 0;
	return input / 1e6 * price.input + cacheRead / 1e6 * price.cacheHit + output / 1e6 * price.output;
}
function newestText(message) {
	if (!message || !Array.isArray(message.content)) return "";
	let text = "";
	for (const b of message.content) if (b && b.type === "text" && typeof b.text === "string") text += b.text + " ";
	return text.trim();
}
/**
* Last assistant message text, for the judge to detect conversation
* references (pronouns / follow-ups) that make a question non-self-contained.
*/
function lastAssistantText(session) {
	try {
		if (!session || !Array.isArray(session.events)) return "";
		for (let i = session.events.length - 1; i >= 0; i--) {
			const e = session.events[i];
			if (e && e.type === "assistant/message" && e.data && e.data.message) {
				const text = (e.data.message.content || []).filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ");
				if (text.trim()) return text.trim().slice(0, 300);
			}
		}
	} catch (error) {}
	return "";
}
function isHeavy(messages) {
	if (!Array.isArray(messages) || messages.length === 0) return false;
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return false;
	const content = last.content;
	let text = "";
	let toolBlocks = 0;
	if (Array.isArray(content)) for (const b of content) {
		if (!b || typeof b !== "object") continue;
		if (b.type === "text" && typeof b.text === "string") text += b.text + " ";
		else if (b.type === "tool-call" || b.type === "tool-result") toolBlocks++;
	}
	let score = Math.min(toolBlocks, 8) * .5;
	score += (text.match(/(实现|重构|修复|调试|排查|设计|架构|优化|审计|迁移|评审|implement|refactor|debug|design|architect|migrate|audit|investigate|analy[sz]e)/gi) || []).length;
	if (text.length > 4e3) score += 1;
	return score >= 2;
}
const emptyTotals = () => ({
	calls: 0,
	inTokens: 0,
	outTokens: 0,
	cacheRead: 0,
	cacheWrite: 0,
	reasoning: 0,
	cost: 0
});
function apply(ctx) {
	const state = {
		globalMode: "auto",
		agentModes: /* @__PURE__ */ new Map(),
		degraded: /* @__PURE__ */ new Map(),
		fallbacks: 0,
		baseModel: /* @__PURE__ */ new Map(),
		provider: /* @__PURE__ */ new Map(),
		catalogCache: /* @__PURE__ */ new Map()
	};
	async function getCatalog(provider) {
		const cached = state.catalogCache.get(provider);
		if (cached) return cached;
		const entry = {
			cheap: null,
			strong: null
		};
		try {
			const models = await ctx.llm.listModels(provider);
			if (Array.isArray(models)) for (const m of models) {
				const id = String(m && m.id || "");
				if (!id) continue;
				if (entry.cheap === null && CHEAP_RE.test(id) && !STRONG_RE.test(id)) entry.cheap = id;
				if (entry.strong === null && STRONG_RE.test(id)) entry.strong = id;
			}
		} catch (error) {
			console.error(`dsh-model-router: model catalog failed for ${provider}: ${String(error)}`);
		}
		state.catalogCache.set(provider, entry);
		return entry;
	}
	/**
	* Zero-prefix one-shot answer on the cheap model. Returns the plain text
	* plus the adapter's usage, or null when the stream produced nothing
	* (caller falls back to the normal flow).
	*/
	async function answerOnCheap(provider, model, question, signal) {
		const stream = ctx.llm.stream({
			provider,
			model,
			messages: [{
				id: `mrtr-ask-${Date.now()}`,
				role: "user",
				content: [{
					type: "text",
					text: "Answer the following question directly and concisely, in the same language as the question. Output only the answer, no preamble.\n\n" + question
				}],
				source: { kind: "user" }
			}],
			maxTokens: 1500,
			reasoningEffort: "off",
			signal
		});
		const blocks = [];
		let usage = null;
		for await (const chunk of stream) {
			if (chunk.type === "usage") usage = chunk.usage;
			if (chunk.type === "block-end" && chunk.block && chunk.block.type === "text" && typeof chunk.block.text === "string") blocks.push(chunk.block.text);
		}
		const text = blocks.join("\n\n").trim();
		return text.length > 0 ? {
			text,
			usage
		} : null;
	}
	/**
	* Cheap-model judge: decide whether a request is a simple direct question
	* or agentic work. Returns 'cheap' for SIMPLE, 'default' otherwise (the
	* caller keeps the normal flow on any ambiguity or failure).
	*/
	async function flashJudge(provider, model, question, context, signal) {
		const stream = ctx.llm.stream({
			provider,
			model,
			messages: [{
				id: `mrtr-judge-${Date.now()}`,
				role: "user",
				content: [{
					type: "text",
					text: "Classify a request. Reply with exactly one word:\n- SIMPLE: the request is self-contained and answerable in a few sentences with no tools, code, files, research, or prior conversation context (definitions, general explanations, translations, trivia, small talk).\n- AGENTIC: it needs tools, code, files, research, or multi-step work, OR it depends on earlier messages — pronouns or references like 它/这个/那个/上面/之前/继续, follow-up questions, or anything referring to previously discussed content.\n" + (context ? "\nLast assistant reply (to detect references): " + context + "\n" : "") + "\nRequest: " + question.slice(0, 500)
				}],
				source: { kind: "user" }
			}],
			maxTokens: 64,
			reasoningEffort: "off",
			signal
		});
		const blocks = [];
		for await (const chunk of stream) if (chunk.type === "block-end" && chunk.block && chunk.block.type === "text" && typeof chunk.block.text === "string") blocks.push(chunk.block.text);
		const text = blocks.join(" ").trim().toUpperCase();
		const simpleAt = text.indexOf("SIMPLE");
		const agenticAt = text.indexOf("AGENTIC");
		if (simpleAt === -1 && agenticAt === -1) return "default";
		if (agenticAt !== -1 && (simpleAt === -1 || agenticAt < simpleAt)) return "default";
		return "cheap";
	}
	ctx.sessionProjections.register({
		key: "modelRouter",
		schema: projectionSchema,
		init: () => ({
			mode: "auto",
			quickAnswers: 0,
			lastQuick: null,
			current: null,
			totals: emptyTotals(),
			byModel: {},
			modelChanges: []
		}),
		apply(state, event) {
			if (event.type === "assistant/message") {
				const data = event.data;
				const message = data && data.message;
				let next = state;
				if (message && typeof message.id === "string" && message.id.startsWith("mrtr-ans-")) {
					const model = message.source && message.source.model ? String(message.source.model) : "";
					const texts = Array.isArray(message.content) ? message.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text) : [];
					next = {
						...next,
						quickAnswers: next.quickAnswers + 1,
						lastQuick: {
							seq: Number(event.seq ?? 0),
							turn: String(data && data.turn || ""),
							model,
							preview: texts.join(" ").trim().slice(0, 200)
						}
					};
				}
				if (data && data.usage) {
					const u = data.usage;
					const model = String(next.current && next.current.model || "unknown");
					const prev = next.byModel[model] || {
						calls: 0,
						inTokens: 0,
						outTokens: 0,
						cacheRead: 0,
						cacheWrite: 0,
						reasoning: 0
					};
					const byModel = {
						...next.byModel,
						[model]: {
							calls: prev.calls + 1,
							inTokens: prev.inTokens + (u.inputTokens || 0),
							outTokens: prev.outTokens + (u.outputTokens || 0),
							cacheRead: prev.cacheRead + (u.cacheReadTokens || 0),
							cacheWrite: prev.cacheWrite + (u.cacheWriteTokens || 0),
							reasoning: prev.reasoning + (u.reasoningTokens || 0)
						}
					};
					const totals = {
						calls: next.totals.calls + 1,
						inTokens: next.totals.inTokens + (u.inputTokens || 0),
						outTokens: next.totals.outTokens + (u.outputTokens || 0),
						cacheRead: next.totals.cacheRead + (u.cacheReadTokens || 0),
						cacheWrite: next.totals.cacheWrite + (u.cacheWriteTokens || 0),
						reasoning: next.totals.reasoning + (u.reasoningTokens || 0),
						cost: next.totals.cost + usageCost(model, u)
					};
					return {
						...next,
						byModel,
						totals
					};
				}
				return next;
			}
			if (event.type === "request/header") {
				const cfg = event.data && event.data.header && event.data.header.config;
				if (!cfg) return state;
				const next = {
					provider: String(cfg.provider || ""),
					model: String(cfg.model || "")
				};
				const cur = state.current;
				if (cur && cur.provider === next.provider && cur.model === next.model) return state;
				const changes = state.modelChanges.length >= 40 ? state.modelChanges.slice(-39) : state.modelChanges.slice();
				changes.push({
					seq: Number(event.seq ?? 0),
					provider: next.provider,
					model: next.model
				});
				return {
					...state,
					current: next,
					modelChanges: changes
				};
			}
			if (event.type === "command/run" && event.data && event.data.name === "router") {
				const args = String(event.data.args || "").trim().toLowerCase();
				const mode = ["auto", "off"].includes(args) ? args : null;
				if (mode === null || state.mode === mode) return state;
				return {
					...state,
					mode
				};
			}
			return state;
		},
		view(state) {
			return state;
		},
		stateVersion: 1
	});
	ctx.on("agent/pre-step", async (payload, next) => {
		const agentId = String(payload.agent.id);
		try {
			const degTurn = state.degraded.get(agentId);
			if (degTurn !== void 0 && degTurn !== payload.turn) state.degraded.delete(agentId);
		} catch (error) {
			console.error(`dsh-model-router: pre-step cleanup failed: ${String(error)}`);
		}
		const live = state.agentModes.get(agentId);
		let mode;
		if (live !== void 0) mode = live;
		else if (state.globalMode !== "auto") mode = state.globalMode;
		else {
			mode = "auto";
			try {
				const snap = ctx.sessionProjections.snapshot(payload.agent.session);
				const v = snap && snap.values && snap.values.modelRouter;
				if (v && v.mode === "off") mode = "off";
			} catch (error) {}
		}
		if (mode !== "auto") return next();
		if (isHeavy(payload.messages)) return next();
		try {
			if (payload.messages.length === 0 || !payload.messages.every((m) => m && m.source && m.source.kind === "user")) return next();
			const question = newestText(payload.messages[payload.messages.length - 1]);
			if (!question) return next();
			const provider = state.provider.get(agentId) || String(payload.agent.options?.provider || "");
			if (!provider) return next();
			const catalog = await getCatalog(provider);
			if (!catalog.cheap) return next();
			const context = lastAssistantText(payload.agent.session);
			if (await flashJudge(provider, catalog.cheap, question, context, payload.signal) !== "cheap") return next();
			const zh = /[\u4e00-\u9fff]/.test(question);
			const quickChoice = zh ? "⚡ 快速回答（flash）" : "⚡ Quick answer (flash)";
			const userQuestions = ctx.get("userQuestions");
			if (userQuestions === void 0) return next();
			let choice;
			try {
				const answer = await userQuestions.ask({
					questions: [{
						id: "route",
						question: zh ? "这条问题用哪种方式回答？" : "How should this question be answered?",
						options: [{
							label: quickChoice,
							description: zh ? "更快、成本更低" : "faster and cheaper"
						}, {
							label: zh ? "主模型回答" : "Main model",
							description: zh ? "质量更高，带完整上下文" : "higher quality, full context"
						}]
					}],
					agent: payload.agent,
					signal: payload.signal
				});
				const item = Array.isArray(answer && answer.answers) ? answer.answers.find((a) => a && a.id === "route") : null;
				choice = item && Array.isArray(item.selected) ? item.selected[0] : void 0;
			} catch (error) {
				console.error(`dsh-model-router: user question failed: ${String(error)}`);
			}
			if (choice !== quickChoice) return next();
			const answer = await answerOnCheap(provider, catalog.cheap, question, payload.signal);
			if (answer === null) return next();
			const session = payload.agent.session;
			for (const message of payload.messages) session.append("user/message", message, { surfaceOp: "append" });
			session.append("request/header", {
				header: { config: {
					provider,
					model: catalog.cheap
				} },
				reason: "change"
			});
			session.append("step/start", {
				turn: payload.turn,
				step: payload.step
			});
			const quickLabel = /[\u4e00-\u9fff]/.test(question) ? "快速回答" : "Quick answer";
			const assistantEvent = {
				turn: payload.turn,
				step: payload.step,
				message: {
					id: `mrtr-ans-${agentId}-${payload.turn}-${payload.step}`,
					role: "assistant",
					content: [{
						type: "text",
						text: `> ⚡ ${quickLabel} · ${catalog.cheap}\n\n${answer.text}`
					}],
					source: {
						kind: "model",
						provider,
						model: catalog.cheap
					}
				}
			};
			if (answer.usage) assistantEvent.usage = answer.usage;
			session.append("assistant/message", assistantEvent, { surfaceOp: "append" });
			session.append("step/end", {
				turn: payload.turn,
				step: payload.step
			});
			console.log(`dsh-model-router: quick-answer #${payload.turn} via ${catalog.cheap} (direct)`);
			return { kind: "reject" };
		} catch (error) {
			console.error(`dsh-model-router: quick-answer failed: ${String(error)}`);
		}
		return next();
	});
	ctx.on("agent/request", async (payload, next) => {
		const base = await next();
		if (!base || !base.provider || !base.model) return base;
		const agentId = String(payload.agent.id);
		state.provider.set(agentId, base.provider);
		state.baseModel.set(agentId, base.model);
		const turn = payload.turn;
		if (state.degraded.get(agentId) === turn) {
			const catalog = await getCatalog(base.provider);
			if (catalog.cheap && catalog.cheap !== base.model) return {
				...base,
				model: catalog.cheap
			};
			return base;
		}
		const options = payload.agent && payload.agent.options;
		if (options && options.model) {
			const provider = options.provider || base.provider;
			if (provider && (base.model !== options.model || base.provider !== provider)) return {
				...base,
				provider,
				model: options.model
			};
		}
		return base;
	});
	ctx.on("agent/request-error", async (payload, next) => {
		const code = payload.failure && payload.failure.code;
		if (!code || !RETRYABLE.includes(code)) return next();
		try {
			const agentId = String(payload.agent.id);
			const turn = payload.turn;
			if (state.degraded.get(agentId) === turn) return next();
			const provider = payload.provider || state.provider.get(agentId);
			if (!provider) return next();
			const catalog = await getCatalog(provider);
			const baseModel = state.baseModel.get(agentId);
			if (!catalog.cheap || baseModel && catalog.cheap === baseModel) return next();
			state.degraded.set(agentId, turn);
			state.fallbacks++;
			console.log(`dsh-model-router: turn ${turn} degraded to ${catalog.cheap} after ${code}`);
			return { kind: "retry" };
		} catch (error) {
			console.error(`dsh-model-router: fallback failed: ${String(error)}`);
			return next();
		}
	});
	ctx.on("llm/adapters-updated", () => {
		state.catalogCache.clear();
	});
	const commands = ctx.get("commands");
	if (commands !== void 0) commands.register({
		name: "router",
		description: "enable or disable quick answers for this session (auto | off)",
		input: { hint: "auto|off" },
		handler: (invocation) => {
			const arg = String(invocation.rawInput || "").trim().toLowerCase();
			const mode = ["auto", "off"].includes(arg) ? arg : null;
			if (mode === null) return {
				kind: "error",
				text: "usage: /router auto|off"
			};
			state.agentModes.set(String(invocation.agent.id), mode);
			return {
				kind: "success",
				text: `quick answers ${mode === "auto" ? "enabled" : "disabled"} for this session`
			};
		}
	});
	ctx.tools.register(defineTool({
		name: "route_model",
		description: "Enable or disable the quick-answer router for this session. auto judges simple questions and answers them on the cheap model; off routes everything through the main model.",
		parameters: { tier: {
			type: "string",
			required: true,
			enum: ["auto", "off"],
			description: "Quick-answer mode for this session: 'auto' enable, 'off' disable."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					mode: { type: "string" },
					cheap: { type: "string" },
					note: { type: "string" }
				}
			},
			render(args, value) {
				const v = value || {};
				return [{
					type: "text",
					text: "quick answers: " + String(v.mode || "?") + (v.cheap ? ", cheap model=" + v.cheap : "") + (v.note ? " — " + v.note : "")
				}];
			}
		},
		async execute(args, exec) {
			const mode = args && args.tier;
			if (!["auto", "off"].includes(mode)) return {
				mode: String(mode),
				cheap: null,
				note: "invalid mode; use auto | off"
			};
			const agent = exec && exec.agent;
			if (!agent) state.globalMode = mode;
			else state.agentModes.set(String(agent.id), mode);
			const provider = agent ? state.provider.get(String(agent.id)) : null;
			return {
				mode,
				cheap: (provider ? await getCatalog(provider) : { cheap: null }).cheap,
				note: mode === "auto" ? "quick answers enabled" : "quick answers disabled"
			};
		}
	}));
}
//#endregion
export { apply, inject };
