import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Account, Limit, Segment, Snapshot } from '../types'

const snapshot = atom({ plugin: 'usage-bars', key: 'snapshot' } as const, null)
const account = atom({ plugin: 'usage-bars', key: 'account' } as const, null)
const now = atom({ plugin: 'usage-bars', key: 'now' } as const, 0)

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const FETCH_EVERY = 5 * 60_000
const FETCH_AT_MOST = 60_000

const WARN = 70
const CRIT = 90

const OK_FILL = '#5f87d7'
const WARN_FILL = '#ffaf00'
const CRIT_FILL = '#ff5f5f'
const EMPTY = '#4e4e4e'
const BUFFER = '#6c6c6c'

const FULL = '█'
const LIGHT = '░'
const MEDIUM = '▒'

export const levelColor = (percent: number) => (percent >= CRIT ? CRIT_FILL : percent >= WARN ? WARN_FILL : OK_FILL)

/** `five_hour` → `5h`, `seven_day` → `Weekly`, `seven_day_fable` → `Fable`. */
export const limitLabel = (kind: string) => {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return 'Weekly'
  if (kind === 'spend_limit') return 'Spend'
  const rest = kind.replace(/^seven_day_/, '').replace(/_/g, ' ')
  return `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`
}

const ORDER = ['five_hour', 'seven_day']
const rank = (kind: string) => (ORDER.includes(kind) ? ORDER.indexOf(kind) : ORDER.length)
const sortLimits = (limits: Limit[]) => [...limits].sort((a, b) => rank(a.kind) - rank(b.kind))

export const compact = (n: number) =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

export const until = (iso: string | undefined, at: number) => {
  const ms = iso ? Date.parse(iso) - at : NaN
  if (!(ms > 0)) return ''
  const minutes = Math.floor(ms / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

type Scope = { model?: { display_name?: string | null } | null; surface?: string | null } | null
type EndpointLimit = { kind?: string; percent?: number; resets_at?: string; scope?: Scope }

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '_')

/** `session` → `five_hour`, `weekly_all` → `seven_day`, a model-scoped week → `seven_day_<model>`. */
const kindOf = (l: EndpointLimit) => {
  if (l.kind === 'session') return 'five_hour'
  if (l.kind === 'weekly_all') return 'seven_day'
  const scope = l.scope?.model?.display_name ?? l.scope?.surface
  if (l.kind === 'weekly_scoped' && scope) return `seven_day_${slug(scope)}`
  return l.kind ?? 'unknown'
}

/**
 * The usage endpoint's windows: its `limits` list (where a per-model week such
 * as Fable lives), else the older `five_hour`/`seven_day*` keys that are set.
 */
export const parseAccount = (text: string): Limit[] => {
  const body = JSON.parse(text) as Record<string, unknown>
  if (Array.isArray(body.limits)) {
    return sortLimits(
      (body.limits as EndpointLimit[])
        .filter(l => typeof l.percent === 'number')
        .map(l => ({ kind: kindOf(l), percent: l.percent as number, resetsAt: l.resets_at })),
    )
  }
  const out: Limit[] = []
  for (const [kind, value] of Object.entries(body)) {
    if (!/^(five_hour|seven_day)/.test(kind) || /oauth_apps/.test(kind)) continue
    if (!value || typeof value !== 'object') continue
    const { utilization, resets_at } = value as { utilization?: unknown; resets_at?: unknown }
    if (typeof utilization !== 'number') continue
    out.push({ kind, percent: utilization, resetsAt: typeof resets_at === 'string' ? resets_at : undefined })
  }
  return sortLimits(out)
}

/** The endpoint's windows over the engine's, the engine's kept where the endpoint has none. */
export const mergeLimits = (engine: Limit[], fromAccount: Limit[]) => {
  const kinds = new Set(fromAccount.map(l => l.kind))
  return sortLimits([...fromAccount, ...engine.filter(l => !kinds.has(l.kind))])
}

/** Splits `width` cells over the segments by largest remainder, so they always add up. */
export const cells = (segments: Segment[], width: number) => {
  const total = segments.reduce((sum, s) => sum + s.tokens, 0) || 1
  const exact = segments.map(s => (s.tokens / total) * width)
  const out = exact.map(Math.floor)
  let left = width - out.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest)
  for (const { i } of order) {
    if (left <= 0) break
    out[i] = (out[i] ?? 0) + 1
    left -= 1
  }
  // A used category with tokens keeps at least one cell, taken from free space.
  segments.forEach((s, i) => {
    if (s.kind === 'used' && s.tokens > 0 && out[i] === 0) {
      const free = segments.findIndex((f, j) => f.kind === 'free' && (out[j] ?? 0) > 1)
      if (free >= 0) {
        out[free] = (out[free] ?? 0) - 1
        out[i] = 1
      }
    }
  })
  return out
}

/** What the context row shows at a given width. */
export type ContextFit = { label: string; showFigures: boolean; legend: number[]; second: number[]; bar: number }

const CTX_MIN_BAR = 10
const CTX_PREF_BAR = 24
const CTX_MAX_BAR = 60
const PCT_WIDTH = 5
const LEGEND_GAP = 3

export const legendText = (s: Segment) => `■ ${s.name} ${compact(s.tokens)}  `

/** The legend entries the first row left out that fit on a row of their own, in order. */
const secondRow = (cols: number, used: Segment[], first: number[]) => {
  let budget = cols
  const out: number[] = []
  used.forEach((s, i) => {
    if (first.includes(i)) return
    const w = legendText(s).length
    if (w <= budget) {
      out.push(i)
      budget -= w
    }
  })
  return out
}

/**
 * Lays the context row out in `cols` cells: the bar and percent always, then the
 * figures, then as many legend entries as fit (largest first, drawn in order);
 * the entries left over go on a second row, as many of those as fit there.
 */
export const fitContext = (cols: number, used: Segment[], figures: string): ContextFit => {
  let label = 'Context  '
  let showFigures = figures.length > 0
  const core = () => label.length + PCT_WIDTH + (showFigures ? figures.length : 0)
  if (core() + CTX_MIN_BAR > cols) showFigures = false
  if (core() + CTX_MIN_BAR > cols) label = 'Ctx '
  if (core() + CTX_MIN_BAR > cols)
    return { label, showFigures, legend: [], second: secondRow(cols, used, []), bar: Math.max(3, cols - core()) }

  let budget = cols - core() - Math.min(CTX_PREF_BAR, Math.max(CTX_MIN_BAR, cols - core() - 40)) - LEGEND_GAP
  const legend: number[] = []
  used
    .map((s, i) => ({ i, s }))
    .sort((a, b) => b.s.tokens - a.s.tokens)
    .forEach(({ i, s }) => {
      const w = legendText(s).length
      if (w <= budget) {
        legend.push(i)
        budget -= w
      }
    })
  legend.sort((a, b) => a - b)
  const legendWidth = legend.reduce((sum, i) => sum + legendText(used[i] as Segment).length, 0)
  const rest = cols - core() - (legend.length ? LEGEND_GAP + legendWidth : 0)
  return {
    label,
    showFigures,
    legend,
    second: secondRow(cols, used, legend),
    bar: Math.max(CTX_MIN_BAR, Math.min(CTX_MAX_BAR, rest)),
  }
}

/** What the limits row shows at a given width. */
export type LimitsFit = { hint: boolean; count: number; bar: number; reset: 'full' | 'short' | 'none'; sep: string }

export type LimitCell = { label: string; percent: number; reset: string }

export const shortReset = (reset: string) => reset.split(' ')[0] ?? ''

const limitWidth = (l: LimitCell, fit: LimitsFit) =>
  l.label.length +
  1 +
  fit.bar +
  ` ${Math.round(l.percent)}%`.length +
  (!l.reset || fit.reset === 'none' ? 0 : 4 + (fit.reset === 'short' ? shortReset(l.reset) : l.reset).length)

export const rowWidth = (hint: string, items: LimitCell[], fit: LimitsFit) =>
  (fit.hint && hint ? hint.length + 5 : 0) +
  items.slice(0, fit.count).reduce((sum, l) => sum + limitWidth(l, fit), 0) +
  Math.max(0, fit.count - 1) * fit.sep.length

type Step = Omit<LimitsFit, 'hint' | 'count'>
const WIDE = '  │  '
const NARROW = ' │ '
const STEPS: Step[] = [
  ...Array.from({ length: 13 }, (_, k): Step => ({ bar: 20 - k, reset: 'full', sep: WIDE })),
  { bar: 8, reset: 'short', sep: WIDE },
  { bar: 6, reset: 'short', sep: NARROW },
  { bar: 6, reset: 'none', sep: NARROW },
  { bar: 4, reset: 'none', sep: NARROW },
  { bar: 0, reset: 'none', sep: NARROW },
]

/**
 * Lays the limits out in `room` cells, giving up detail in this order: bar
 * length, the reset's minutes, the reset, the bar, the engine's hint, then the
 * last windows.
 */
export const fitLimits = (room: number, hint: string, items: LimitCell[]): LimitsFit => {
  for (const withHint of [true, false]) {
    for (const step of STEPS) {
      const fit = { ...step, hint: withHint, count: items.length }
      if (rowWidth(hint, items, fit) <= room) return fit
    }
  }
  const last: LimitsFit = { ...(STEPS[STEPS.length - 1] as Step), hint: false, count: items.length }
  while (last.count > 0 && rowWidth(hint, items, last) > room) last.count--
  return last
}

const toLimits = (rateLimits: SessionRateLimit[]): Limit[] =>
  sortLimits(rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt })))

const toSnapshot = (context: SessionContextUsage, rateLimits: SessionRateLimit[]): Snapshot => {
  const breakdown = context.breakdown
  const segments: Segment[] = (breakdown?.categories ?? [])
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind as Segment['kind'] }))
  return {
    limits: toLimits(rateLimits),
    percent: breakdown ? breakdown.percentage : context.percent,
    tokens: breakdown ? breakdown.totalTokens : context.tokens,
    window: breakdown ? breakdown.rawMaxTokens : context.window,
    segments,
  }
}

const measure = async ($: EngineInterface) => {
  const usage = await $.session.usage({ breakdown: 'summary' })
  await update($, snapshot, () => toSnapshot(usage.context, usage.rateLimits))
}

/** Reads the account's windows; the engine sets the credential, the plugin never sees it. */
const fetchAccount = async ($: EngineInterface, force = false) => {
  const last = await read($, account)
  if (!force && last && Date.now() - last.fetchedAt < FETCH_AT_MOST) return
  const auth = await $.session.authorize()
  if (!auth || auth.kind !== 'bearer') return
  const res = await $.http.fetch(USAGE_URL, {
    auth: auth.handle,
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
  })
  if (!res.ok) {
    await update($, account, a => (a ? { ...a, raw: `HTTP ${res.status}: ${res.text.slice(0, 500)}` } : a))
    return
  }
  const limits = parseAccount(res.text)
  const fetched: Account = { limits, fetchedAt: Date.now(), raw: res.text }
  await update($, account, () => fetched)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await update($, now, () => Date.now())
    $.clock.every(30_000, () => void update($, now, () => Date.now()))
    $.clock.every(FETCH_EVERY, () => void fetchAccount($).catch(() => undefined))
    await $.command.register({ name: 'usage-bars', description: 'Show the raw usage figures the bars are drawn from' })
    void measure($).catch(() => undefined)
    void fetchAccount($, true).catch(() => undefined)
    return result
  })

  on('command.run', { command: 'usage-bars' }, async $ => {
    await fetchAccount($, true).catch(() => undefined)
    const a = await read($, account)
    const s = await read($, snapshot)
    return {
      text: [
        `Engine windows: ${JSON.stringify(s?.limits ?? [])}`,
        `Usage endpoint: ${a ? a.raw : 'no reading (no subscription login?)'}`,
      ].join('\n'),
    }
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) {
      await measure($).catch(() => undefined)
    } else {
      await update($, snapshot, s => (s ? { ...s, limits: toLimits(e.rateLimits) } : s))
    }
    if (e.changed.includes('rateLimits')) void fetchAccount($).catch(() => undefined)
    await update($, now, () => Date.now())
    return result
  })

  // Context above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || !snap) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const percent = snap.percent ?? 0
    const level = levelColor(percent)
    const segs: Segment[] = snap.segments.length
      ? snap.segments
      : [
          { name: 'Used', tokens: snap.tokens ?? 0, color: OK_FILL, kind: 'used' },
          { name: 'Free', tokens: Math.max(0, snap.window - (snap.tokens ?? 0)), color: EMPTY, kind: 'free' },
        ]
    const used = segs.filter(s => s.kind === 'used')
    const figures = snap.tokens !== undefined ? `  ${compact(snap.tokens)}/${compact(snap.window)}` : ''
    // One cell spare: a row exactly as wide as the band wraps on some terminals.
    const fit = fitContext(e.props.bodyColumns - 1, used, figures)
    const widths = cells(segs, fit.bar)

    const legendItem = (i: number) => {
      const s = used[i] as Segment
      return (
        <Text key={`legend-${s.name}-${i}`} wrap="truncate">
          <Text color={s.color}>■ </Text>
          <Text dimColor>{`${s.name} ${compact(s.tokens)}  `}</Text>
        </Text>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="nowrap">
          <Text color={percent >= WARN ? level : undefined} bold wrap="truncate">
            {fit.label}
          </Text>
          {segs.map((s, i) =>
            widths[i] ? (
              <Text
                key={`${s.name}-${i}`}
                color={s.kind === 'free' ? EMPTY : s.kind === 'buffer' ? BUFFER : s.color}
                wrap="truncate"
              >
                {(s.kind === 'used' ? FULL : s.kind === 'buffer' ? MEDIUM : LIGHT).repeat(widths[i] ?? 0)}
              </Text>
            ) : null,
          )}
          <Text color={level} bold wrap="truncate">
            {` ${Math.round(percent)}%`.padStart(PCT_WIDTH)}
          </Text>
          {fit.showFigures ? (
            <Text dimColor wrap="truncate">
              {figures}
            </Text>
          ) : null}
          {fit.legend.length ? <Text wrap="truncate">{' '.repeat(LEGEND_GAP)}</Text> : null}
          {fit.legend.map(legendItem)}
        </Box>
        {fit.second.length ? (
          <Box flexDirection="row" flexWrap="nowrap">
            {fit.second.map(legendItem)}
          </Box>
        ) : null}
      </Box>
    )
  })

  // Limits in the footer row, after the engine's hint, on the same line.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    const acc = await read($, account)
    const limits = mergeLimits(snap?.limits ?? [], acc?.limits ?? [])
    if (!limits.length) return next(e)

    const at = (await read($, now)) || Date.now()
    const { Box, Text } = $.ui.resolve(e)
    const hint = e.props.hint
    const items: LimitCell[] = limits.map(l => ({
      label: limitLabel(l.kind),
      percent: l.percent,
      reset: until(l.resetsAt, at),
    }))
    // The footer draws the mode label left of this row ("⏵⏵ auto mode on (shift+tab to cycle) · "),
    // which the hook is not told; reserve its longest form, less what the hint already holds.
    const reserve = /shift\+tab/.test(hint) ? 22 : 42
    const fit = fitLimits((e.viewport?.columns ?? 120) - reserve, hint, items)
    if (!fit.count) return next(e)

    return (
      <Box flexDirection="row" flexWrap="nowrap">
        {fit.hint && hint ? <Text dimColor wrap="truncate">{`${hint}  ·  `}</Text> : null}
        {items.slice(0, fit.count).map((l, i) => {
          const filled = Math.max(0, Math.min(fit.bar, Math.round((l.percent / 100) * fit.bar)))
          const color = levelColor(l.percent)
          const reset = fit.reset === 'none' ? '' : fit.reset === 'short' ? shortReset(l.reset) : l.reset
          return (
            <Box key={`${l.label}-${i}`} flexDirection="row" flexShrink={0}>
              {i ? <Text dimColor>{fit.sep}</Text> : null}
              <Text bold>{`${l.label} `}</Text>
              {fit.bar ? <Text color={color}>{FULL.repeat(filled)}</Text> : null}
              {fit.bar ? <Text color={EMPTY}>{LIGHT.repeat(fit.bar - filled)}</Text> : null}
              <Text color={color} bold>{` ${Math.round(l.percent)}%`}</Text>
              {reset ? <Text dimColor>{`  ↻ ${reset}`}</Text> : null}
            </Box>
          )
        })}
      </Box>
    )
  })
}
