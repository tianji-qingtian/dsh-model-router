/**
 * dsh-model-router — client half.
 *
 * A compact panel in the composer dock (`conversation.composer.dock`):
 * tier buttons (Auto / 省 / 强), the currently active model, live per-session
 * token / cache-hit / cost figures, and a per-model usage breakdown.
 *
 * All read-side data flows through the `modelRouter` session projection
 * (standard `useProjection` slot prop — no RPC, reactive updates). The tier
 * buttons execute the `/router` slash command through the harness's existing
 * commands remote (`ctx.remote.commands.execute`), so no custom wire protocol
 * is invented here.
 */
import { createElement, useState } from 'react'

export const inject = ['slots']

const ID = 'dsh-model-router'

const CSS = `
.mrtr { font-size: 11px; line-height: 1.5; opacity: .92; }
.mrtr-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mrtr-label { font-weight: 600; opacity: .7; }
.mrtr-btn { border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; border-radius: 999px; padding: 1px 8px; font-size: 11px; cursor: pointer; opacity: .7; }
.mrtr-btn:hover { opacity: 1; }
.mrtr-btn:disabled { opacity: .4; cursor: default; }
.mrtr-btn-active { opacity: 1; background: rgba(127,127,127,.18); font-weight: 600; }
.mrtr-meta { opacity: .65; }
.mrtr-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin-right: 6px; }
.mrtr-chip { opacity: .8; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrtr-details { margin-top: 2px; opacity: .8; }
.mrtr-details summary { cursor: pointer; opacity: .65; }
.mrtr-row { display: flex; gap: 8px; padding: 1px 0; }
`

/** One <style data-plugin> tag per load; the loader removes plugin-owned tags on unload. */
function injectStyle() {
  const tagId = `${ID}/dock.css`
  if (typeof document !== 'undefined'
    && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = ID
    tag.dataset.pluginCss = tagId
    tag.textContent = CSS
    document.head.appendChild(tag)
  }
}

const fmt = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

const fmtCost = (c) => {
  if (typeof c !== 'number' || !Number.isFinite(c)) return '—'
  return c.toFixed(c < 0.1 ? 4 : 2)
}

export function apply(ctx) {
  injectStyle()

  function RouterDock(props) {
    const stats = props.useProjection('modelRouter')
    const sessionId = props.sessionId ? String(props.sessionId) : ''
    const [busy, setBusy] = useState(false)

    const mode = stats ? stats.mode : 'auto'
    const current = stats ? stats.current : null
    const totals = stats ? stats.totals : null
    const byModel = stats ? stats.byModel : null
    // inputTokens excludes cache reads (disjoint harness counts): the hit rate
    // is hit / (hit + miss).
    const totalPrompt = totals ? totals.inTokens + totals.cacheRead : 0
    const cacheHitRate = totalPrompt > 0
      ? Math.round((totals.cacheRead / totalPrompt) * 100)
      : 0

    const setMode = (tier) => {
      setBusy(true)
      const remote = ctx.get('remote')
      const run = remote && remote.commands
        ? remote.commands.execute(sessionId, '/router ' + tier)
        : Promise.reject(new Error('commands remote unavailable'))
      run.catch(() => {}).finally(() => setBusy(false))
    }

    const modeBtn = (tier, label, title) => createElement('button', {
      key: tier,
      type: 'button',
      className: 'mrtr-btn' + (mode === tier ? ' mrtr-btn-active' : ''),
      title,
      disabled: busy || sessionId === '',
      onClick: () => setMode(tier),
    }, label)

    const modelRows = Object.keys(byModel || {}).sort().map((model) => {
      const m = byModel[model]
      return createElement('div', { key: model, className: 'mrtr-row' },
        createElement('span', { className: 'mrtr-mono' }, model),
        createElement('span', { className: 'mrtr-meta' },
          m.calls + ' calls · miss ' + fmt(m.inTokens) + ' · out ' + fmt(m.outTokens)
          + ' · cache ' + fmt(m.cacheRead)),
      )
    })

    return createElement('div', { className: 'mrtr' },
      createElement('div', { className: 'mrtr-bar' },
        createElement('span', { className: 'mrtr-label' }, '⚡Router'),
        modeBtn('auto', 'Auto', 'heuristic routing: trivial steps run on the cheap model'),
        modeBtn('cheap', '省', 'force the cheapest catalog model'),
        modeBtn('strong', '强', 'force the strongest catalog model'),
        current ? createElement('span', {
          className: 'mrtr-chip',
          title: current.provider + ' / ' + current.model,
        }, current.model) : null,
        totals ? createElement('span', { className: 'mrtr-meta', title: 'estimated cost; input excludes cache hits (disjoint counts), prices are configurable estimates' },
          'miss ' + fmt(totals.inTokens)
          + ' · out ' + fmt(totals.outTokens)
          + ' · cache ' + cacheHitRate + '%'
          + ' · ≈$' + fmtCost(totals.cost)) : null,
      ),
      Object.keys(byModel || {}).length > 0 ? createElement('details', { className: 'mrtr-details' },
        createElement('summary', null, 'usage (' + (totals ? totals.calls : 0) + ' calls)'),
        modelRows) : null,
    )
  }

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'model-router' },
    (props) => createElement(RouterDock, props),
  ))
}
