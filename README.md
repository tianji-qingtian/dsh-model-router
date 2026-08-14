# dsh-model-router

Model Router & Cost Optimizer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Routes every agent step to the cheapest sufficient model, degrades gracefully on transient provider failures, and shows live per-session token / cache-hit / cost figures right under the composer.

> The harness is in developer preview and iterates quickly — expect compatibility-breaking changes.

## Features

- **Heuristic tier routing** — at turn start the *newest user message* is classified (`agent/pre-step`: task keywords + payload size; history is deliberately ignored so a long agentic conversation can still route a trivial follow-up cheap). Trivial prompts (是什么 / 解释 / 翻译 / hello …) go to the cheap catalog model; agentic work (实现 / 重构 / 调试 …) stays on the strong one. The chosen tier is **sticky within a turn**.
- **Switch-cost hysteresis** — every model flip pays a full-prefix cache miss on the target model (a long cached session is cheapest *staying put*). So cheap routing engages only after **two consecutive cheap-classified turns**, while heavy turns switch back immediately. Manual mode (`/router`, `route_model`, dock buttons) bypasses the hysteresis.
- **Automatic fallback** — transient failures (`RATE_LIMIT`, `SERVER`, `TIMEOUT`, `EMPTY_RESPONSE`) degrade the turn to the cheap model and retry once; anything else delegates to the provider's own retry policy.
- **Real usage metering** — a session projection folds the durable log: real adapter token usage (input / output / cache read / cache write / reasoning), per-model breakdown, and estimated cost from a model-class price table. Projection-based, so the numbers are replay-safe and survive cold sessions.
- **Composer dock panel** — tier buttons (Auto / 省 / 强), current model, `miss/out/cache%/≈$` line, and a per-model usage breakdown. Reactively driven by `useProjection`; buttons reuse the built-in `commands` remote — no custom wire protocol.
- **Manual control** — `/router auto|cheap|strong` slash command, and a model-visible `route_model` tool so the agent itself can request a tier mid-task.

## Install

### Prerequisites

The `dsh` CLI must be on your `PATH`. If you only ever ran the harness through `npx`, `dsh` is not installed and you will get `zsh: command not found: dsh` — install it globally first:

```sh
npm install -g @deepseek-ai/dsh
```

`pnpm add -g @deepseek-ai/dsh` also works if your pnpm global bin dir is on `PATH` (otherwise pnpm asks you to run `pnpm setup` first). Alternatively skip the global install and prefix the commands below with `npx @deepseek-ai/dsh …`.

### Add the bundle

```sh
# 1. add the bundle to your web profile (pnpm-backed; the built lib/ artifacts
#    are committed in this repo, so no build script runs at install time)
dsh plugin --profile web add "github:tianji-qingtian/dsh-model-router#main"

# 2. restart the harness with that profile — `add` only edits the profile
#    files; a running instance does not hot-load the new bundle
dsh --profile web
```

After the restart the ⚡Router panel appears under the composer in the Web UI, and the `/router` command plus the `route_model` tool are registered once the host half loads. Verify under Settings → Plugins that `dsh-model-router` is listed.

> A dynamic (session-only) prototype with the same name may already be running inside one session; it is unrelated to the installed bundle and disappears with the harness process.

## How it works

| Piece | Mechanism |
| --- | --- |
| Step classification | `agent/pre-step` waterfall (read-only observer) |
| Model substitution | `agent/request` waterfall — replaces the call config's `model` |
| Failure fallback | `agent/request-error` waterfall — returns `{ kind: 'retry' }` after flagging the turn; the retry re-enters `agent/request` and lands on the cheap model |
| Stats | `sessionProjections.register('modelRouter', …)` folded over `request/header`, `command/run`, and `assistant/message` events |
| Dock UI | `conversation.composer.dock` slot + standard `useProjection` prop |
| Manual control | `/router` command (`commands` service) + `route_model` tool (`tools` registry) |

The cheap/strong model pair is discovered at runtime from the provider's catalog (`llm.listModels`): ids matching `flash|chat|mini|turbo|haiku|lite|air|nano` are cheap candidates, `pro|reasoner|opus|sonnet|max|ultra|premium|r1` are strong. With the stock DeepSeek adapter that is `deepseek-v4-flash` ↔ `deepseek-v4-pro`.

## Cost estimates

The price table is a model-class estimate (USD per 1M tokens) living at the top of [`src/index.js`](src/index.js):

```js
const PRICE_TABLE = [
  { test: CHEAP_RE, input: 0.27, output: 1.10, cacheHit: 0.07 },
  { test: STRONG_RE, input: 0.55, output: 2.19, cacheHit: 0.14 },
]
```

Edit it to match your account's actual pricing; the panel always labels the number with `≈`. Cache hits are billed at the cache-hit price, not the input price.

**Counting semantics:** harness `TokenUsage` fields are *disjoint* — `inputTokens` already excludes cache reads (DeepSeek reports `prompt_tokens = hit + miss`; the adapter subtracts hits out). The panel therefore shows `miss … · cache N%` where the hit rate is `hit / (hit + miss)`; a healthy long conversation typically sits in the high 90s.

## Known limitations

- The router is a static plugin: routing state (mode, degradation, streak) is process-local and resets with the harness. Durable numbers live in the projection.
- `useProjection`-driven stats reflect the whole session log — history recorded before installation is included, which is intentional.
- The switch-cost hysteresis is a fixed 2-turn heuristic. A precise switch-aware cost model (compare expected savings against the target model's prefix-miss rebuild cost, driven by the projection's real cache numbers) is planned as a follow-up.

## License

MIT
