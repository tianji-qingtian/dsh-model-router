# dsh-model-router

Model Router & Cost Optimizer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Routes every agent step to the cheapest sufficient model, degrades gracefully on transient provider failures, and shows live per-session token / cache-hit / cost figures right under the composer.

> The harness is in developer preview and iterates quickly — expect compatibility-breaking changes.

## Features

- **Heuristic tier routing** — every step is classified before dispatch (`agent/pre-step`: tool-call depth, task keywords, payload size). Trivial prompts (是什么 / 解释 / 翻译 / hello …) run on the cheap catalog model; agentic work (实现 / 重构 / 调试 + tool loops) stays on the strong one. The chosen tier is **sticky within a turn**, so mid-turn flips don't thrash the provider's prefix cache — every model switch pays a full-miss rebuild of that model's cache.
- **Automatic fallback** — transient failures (`RATE_LIMIT`, `SERVER`, `TIMEOUT`, `EMPTY_RESPONSE`) degrade the turn to the cheap model and retry once; anything else delegates to the provider's own retry policy.
- **Real usage metering** — a session projection folds the durable log: real adapter token usage (input / output / cache read / cache write / reasoning), per-model breakdown, and estimated cost from a model-class price table. Projection-based, so the numbers are replay-safe and survive cold sessions.
- **Composer dock panel** — tier buttons (Auto / 省 / 强), current model, `in/out/cache%/≈$` line, and a per-model usage breakdown. Reactively driven by `useProjection`; buttons reuse the built-in `commands` remote — no custom wire protocol.
- **Manual control** — `/router auto|cheap|strong` slash command, and a model-visible `route_model` tool so the agent itself can request a tier mid-task.

## Install

```sh
dsh plugin --profile web add "github:YOUR_USER/dsh-model-router#main"
```

Restart `dsh --profile web`. The panel appears under the composer; the `/router` command and `route_model` tool are registered once the host half loads.

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

## Known limitations

- The router is a static plugin: routing state (mode, degradation) is process-local and resets with the harness. Durable numbers live in the projection.
- `useProjection`-driven stats reflect the whole session log — history recorded before installation is included, which is intentional.
- Model-switch thrash protection is turn-level stickiness; a switch-aware cost model (compare expected savings vs. prefix-miss rebuild cost) is a planned v2.

## License

MIT
