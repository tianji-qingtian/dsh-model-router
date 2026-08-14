/**
 * dsh-model-router — client half.
 *
 * A compact panel in the composer dock (`conversation.composer.dock`):
 * an Auto / 关闭 (off) toggle, the currently active model, live per-session
 * token / cache-hit / cost figures, a per-model usage breakdown, and a brief
 * inline highlight whenever a question is answered directly on the cheap
 * model (the answer itself appears in the chat as an ordinary message).
 *
 * UI text is localized through the harness `locale` service (zh + en). Read
 * data flows through the `modelRouter` session projection (standard
 * `useProjection` slot prop — no RPC). The toggle executes the `/router`
 * slash command through the harness's existing `commands` remote.
 */
import { createElement, useEffect, useRef, useState } from 'react'

export const inject = ['slots', 'timer']

const ID = 'dsh-model-router'

const CSS = `
.mrtr { position: relative; font-size: 11px; line-height: 1.5; opacity: .92; }
.mrtr-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mrtr-label { font-weight: 600; opacity: .7; }
.mrtr-btn { border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; border-radius: 999px; padding: 1px 8px; font-size: 11px; cursor: pointer; opacity: .7; }
.mrtr-btn:hover { opacity: 1; }
.mrtr-btn:disabled { opacity: .4; cursor: default; }
.mrtr-btn-active { opacity: 1; background: rgba(127,127,127,.18); font-weight: 600; }
.mrtr-meta { opacity: .65; }
.mrtr-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin-right: 6px; }
.mrtr-chip { opacity: .8; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrtr-flash { color: #4ec9b0; opacity: .95; animation: mrtr-fade 6s ease-out forwards; }
@keyframes mrtr-fade { 0% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }
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

const ZH = {
  'mode.auto': 'Auto',
  'mode.off': '关闭',
  'mode.auto.title': '自动：简单问题由 flash 直接作答，重活走主模型',
  'mode.off.title': '关闭快速回答：所有请求都走主模型',
  'qa.title': '由便宜模型直接作答的问题数',
  'flash.done': '已作答',
  'usage.calls': '用量',
}
const EN = {
  'mode.auto': 'Auto',
  'mode.off': 'Off',
  'mode.auto.title': 'Auto: simple questions answered directly on the cheap model, heavy work uses the main model',
  'mode.off.title': 'Disable quick answers: route everything through the main model',
  'qa.title': 'questions answered directly on the cheap model',
  'flash.done': 'answered',
  'usage.calls': 'usage',
}

export function apply(ctx) {
  injectStyle()

  const locale = ctx.get('locale')
  let t = (key) => key
  if (locale) {
    try {
      locale.register('dsh-model-router', 'zh', ZH)
      locale.register('dsh-model-router', 'en', EN)
      t = locale.bind('dsh-model-router')
    } catch (error) {
      console.error('dsh-model-router: locale registration failed: ' + String(error))
    }
  }

  function RouterDock(props) {
    const stats = props.useProjection('modelRouter')
    const sessionId = props.sessionId ? String(props.sessionId) : ''
    const [busy, setBusy] = useState(false)
    const [flash, setFlash] = useState(null)
    const [, setLocaleTick] = useState(0)
    const lastQuickSeq = useRef(-1)

    // Re-render on locale switch.
    useEffect(() => {
      const loc = ctx.get('locale')
      if (!loc || typeof loc.subscribe !== 'function') return undefined
      return loc.subscribe(() => setLocaleTick((x) => x + 1))
    }, [])

    // Briefly highlight when a new quick answer lands (inline, not a toast).
    useEffect(() => {
      const q = stats && stats.lastQuick ? stats.lastQuick.seq : -1
      if (q >= 0 && q !== lastQuickSeq.current) {
        lastQuickSeq.current = q
        setFlash(stats.lastQuick)
      }
    }, [stats])

    useEffect(() => {
      if (!flash) return undefined
      return ctx.interval(() => setFlash(null), 6000)
    }, [flash])

    const mode = stats ? stats.mode : 'auto'
    const current = stats ? stats.current : null
    const totals = stats ? stats.totals : null
    const byModel = stats ? stats.byModel : null
    const totalPrompt = totals ? totals.inTokens + totals.cacheRead : 0
    const cacheHitRate = totalPrompt > 0
      ? Math.round((totals.cacheRead / totalPrompt) * 100)
      : 0

    const setMode = (next) => {
      setBusy(true)
      const remote = ctx.get('remote')
      const run = remote && remote.commands
        ? remote.commands.execute(sessionId, '/router ' + next)
        : Promise.reject(new Error('commands remote unavailable'))
      run.catch(() => {}).finally(() => setBusy(false))
    }

    const modeBtn = (value, label, title) => createElement('button', {
      key: value,
      type: 'button',
      className: 'mrtr-btn' + (mode === value ? ' mrtr-btn-active' : ''),
      title,
      disabled: busy || sessionId === '',
      onClick: () => setMode(value),
    }, label)

    const modelRows = Object.keys(byModel || {}).sort().map((model) => {
      const m = byModel[model]
      return createElement('div', { key: model, className: 'mrtr-row' },
        createElement('span', { className: 'mrtr-mono' }, model),
        createElement('span', { className: 'mrtr-meta' },
          m.calls + ' · miss ' + fmt(m.inTokens) + ' · out ' + fmt(m.outTokens)
          + ' · cache ' + fmt(m.cacheRead)),
      )
    })

    return createElement('div', { className: 'mrtr' },
      createElement('div', { className: 'mrtr-bar' },
        createElement('span', { className: 'mrtr-label' }, '⚡Router'),
        modeBtn('auto', t('mode.auto'), t('mode.auto.title')),
        modeBtn('off', t('mode.off'), t('mode.off.title')),
        current ? createElement('span', {
          className: 'mrtr-chip',
          title: current.provider + ' / ' + current.model,
        }, current.model) : null,
        stats && stats.quickAnswers > 0 ? createElement('span', {
          className: 'mrtr-meta',
          title: t('qa.title'),
        }, 'QA×' + stats.quickAnswers) : null,
        flash ? createElement('span', {
          className: 'mrtr-flash',
          title: t('qa.title'),
        }, '⚡' + (flash.model || 'flash') + ' ' + t('flash.done')) : null,
        totals ? createElement('span', { className: 'mrtr-meta', title: 'estimated cost; input excludes cache hits (disjoint counts), prices are configurable estimates' },
          'miss ' + fmt(totals.inTokens)
          + ' · out ' + fmt(totals.outTokens)
          + ' · cache ' + cacheHitRate + '%'
          + ' · ≈$' + fmtCost(totals.cost)) : null,
      ),
      Object.keys(byModel || {}).length > 0 ? createElement('details', { className: 'mrtr-details' },
        createElement('summary', null, t('usage.calls') + ' (' + (totals ? totals.calls : 0) + ')'),
        modelRows) : null,
    )
  }

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'model-router' },
    (props) => createElement(RouterDock, props),
  ))
}
