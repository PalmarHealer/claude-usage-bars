import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Account, Limit, Segment, Snapshot } from '../types'

const snapshot = atom({ plugin: 'usage-bars', key: 'snapshot' } as const, null)
const account = atom({ plugin: 'usage-bars', key: 'account' } as const, null)
const now = atom({ plugin: 'usage-bars', key: 'now' } as const, 0)
const frame = atom({ plugin: 'usage-bars', key: 'frame' } as const, 0)

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const FETCH_EVERY = 5 * 60_000
/** A reading younger than this, from any session, is used as it is. */
const FRESH_FOR = 4 * 60_000
/** A forced reading (`/usage-bars`) still waits this long after the last one. */
const FORCE_GAP = 30_000
const BACKOFF_FIRST = 5 * 60_000
const BACKOFF_MOST = 60 * 60_000
const FRAME_MS = 120

const BUFFER = '#6c6c6c'
/** Text drawn on a filled cell, and on an empty one, in overlay mode. */
const ON_FILL = '#1c1c1c'
const ON_EMPTY = '#e4e4e4'

// With the `solid` style the bars draw these glyphs on a background of their own
// colour: a solid cell where the terminal paints backgrounds, the glyph where not.
const FULL = '█'
const LIGHT = '░'
const MEDIUM = '▒'

/** What the person can set in `/config`; `readConfig` turns the stored options into this. */
export type Config = {
  /** `compact` always draws the label and percent on the bar; `auto` only when there is no room. */
  layout: 'auto' | 'compact'
  /** `solid` paints a background under the bar glyphs; `glyphs` draws the glyphs alone. */
  style: 'solid' | 'glyphs'
  animation: 'off' | 'wave' | 'pulse'
  showContext: boolean
  showLimits: boolean
  showBars: boolean
  showPercent: boolean
  showTokens: boolean
  showLegend: boolean
  showResets: boolean
  /** `categories`: the context bar in the colours `/context` uses; `level`: in the fill colour. */
  contextColors: 'categories' | 'level'
  okColor: string
  warnColor: string
  critColor: string
  emptyColor: string
  warnAt: number
  critAt: number
}

export const DEFAULTS: Config = {
  layout: 'auto',
  style: 'solid',
  animation: 'off',
  showContext: true,
  showLimits: true,
  showBars: true,
  showPercent: true,
  showTokens: true,
  showLegend: true,
  showResets: true,
  contextColors: 'categories',
  okColor: '#5f87d7',
  warnColor: '#ffaf00',
  critColor: '#ff5f5f',
  emptyColor: '#4e4e4e',
  warnAt: 70,
  critAt: 90,
}

const HEX = /^#?([0-9a-f]{6})$/i

/** The stored options over the defaults; a value of the wrong kind, or a colour that is not `#rrggbb`, is left at its default. */
export const readConfig = (options: Readonly<Record<string, unknown>> = {}): Config => {
  const out: Record<string, unknown> = { ...DEFAULTS }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const v = options[key]
    if (typeof v !== typeof fallback) continue
    if (key.endsWith('Color')) {
      const m = HEX.exec((v as string).trim())
      if (m) out[key] = `#${m[1]}`
    } else if (typeof v === 'number') {
      if (Number.isFinite(v)) out[key] = Math.max(0, Math.min(100, v))
    } else out[key] = v
  }
  return out as Config
}

let config: Config = DEFAULTS

export const levelColor = (percent: number, c: Config = DEFAULTS) =>
  percent >= c.critAt ? c.critColor : percent >= c.warnAt ? c.warnColor : c.okColor

/** `hex` moved `t` of the way to white; a colour that is not hex is left as it is. */
export const lighten = (hex: string, t: number) => {
  const m = HEX.exec(hex)
  if (!m || t <= 0) return hex
  const n = parseInt(m[1] as string, 16)
  const ch = (shift: number) => {
    const v = (n >> shift) & 255
    return Math.round(v + (255 - v) * Math.min(1, t))
      .toString(16)
      .padStart(2, '0')
  }
  return `#${ch(16)}${ch(8)}${ch(0)}`
}

/** How much brighter cell `i` of a filled run is at animation frame `f`, in steps of 0.05. */
export const glow = (animation: Config['animation'], f: number, i: number) => {
  const raw =
    animation === 'wave'
      ? 0.4 * (0.5 + 0.5 * Math.sin(f * 0.5 - i * 0.45)) ** 3
      : animation === 'pulse'
        ? 0.3 * (0.5 + 0.5 * Math.sin(f * 0.3))
        : 0
  return Math.round(raw * 20) / 20
}

/** The percent is kept whenever the bars are hidden, so a limit still says something. */
const showPct = (c: Config) => c.showPercent || !c.showBars

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

/**
 * What the context row shows at a given width. With `overlay` the label and
 * percent are drawn on the bar, which is then `bar` cells wide in all.
 */
export type ContextFit = {
  label: string
  showFigures: boolean
  legend: number[]
  second: number[]
  bar: number
  overlay?: boolean
}

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

/** ` Context  12% `, padded to `width`: what the bar is drawn behind in overlay mode. */
export const overlayContext = (label: string, percent: number, width: number, pct = true) =>
  ` ${label}${pct ? ` ${Math.round(percent)}%`.padStart(PCT_WIDTH) : ''} `.padEnd(width)

const overlayMin = (label: string, c: Config) => label.length + (showPct(c) ? PCT_WIDTH : 0) + 2

/** One way to lay the row out, or nothing when it does not fit in `cols`. */
const tryContext = (
  cols: number,
  used: Segment[],
  figures: string,
  label: string,
  overlay: boolean,
  showFigures: boolean,
  c: Config,
): ContextFit | undefined => {
  const fixed = overlay ? 0 : label.length + (showPct(c) ? PCT_WIDTH : 0)
  const minBar = overlay ? overlayMin(label, c) : c.showBars ? CTX_MIN_BAR : 0
  const prefBar = c.showBars ? Math.max(minBar, CTX_PREF_BAR) : 0
  const maxBar = c.showBars ? Math.max(minBar, CTX_MAX_BAR) : 0
  const core = fixed + (showFigures ? figures.length : 0)
  if (core + minBar > cols) return undefined

  let budget = cols - core - Math.min(prefBar, Math.max(minBar, cols - core - 40)) - LEGEND_GAP
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
  const rest = cols - core - (legend.length ? LEGEND_GAP + legendWidth : 0)
  return {
    label,
    showFigures,
    legend,
    second: secondRow(cols, used, legend),
    bar: Math.max(minBar, Math.min(maxBar, rest)),
    overlay: overlay || undefined,
  }
}

/**
 * Lays the context row out in `cols` cells: the bar and percent always, then the
 * figures, then as many legend entries as fit (largest first, drawn in order);
 * the entries left over go on a second row, as many of those as fit there.
 * Too narrow for a bar of its own (or set to `compact`), the label and percent
 * go on the bar, then the figures go, then the label shortens.
 */
export const fitContext = (cols: number, used: Segment[], figures: string, c: Config = DEFAULTS): ContextFit => {
  const fig = figures.length > 0
  const ways: [string, boolean, boolean][] = !c.showBars
    ? [['Context  ', false, fig], ['Context  ', false, false], ['Ctx ', false, false]]
    : [
        ...(c.layout === 'compact' ? [] : [['Context  ', false, fig] as [string, boolean, boolean]]),
        ['Context', true, fig],
        ['Context', true, false],
        ['Ctx', true, false],
      ]
  for (const [label, overlay, showFigures] of ways) {
    const fit = tryContext(cols, used, figures, label, overlay, showFigures, c)
    if (fit) return fit
  }
  const [label, overlay] = ways[ways.length - 1] as [string, boolean, boolean]
  const minBar = overlay ? overlayMin(label, c) : 0
  return { label, showFigures: false, legend: [], second: secondRow(cols, used, []), bar: minBar, overlay: overlay || undefined }
}

/** What the limits row shows at a given width. `overlay`: the label and percent are drawn on the bar. */
export type LimitsFit = {
  hint: boolean
  count: number
  bar: number
  overlay?: boolean
  reset: 'full' | 'short' | 'none'
  sep: string
}

export type LimitCell = { label: string; percent: number; reset: string }

export const shortReset = (reset: string) => reset.split(' ')[0] ?? ''

const pctText = (l: LimitCell) => ` ${Math.round(l.percent)}%`

/** ` 5h 41% `: the text the bar is drawn behind in overlay mode. */
export const overlayText = (l: LimitCell, c: Config = DEFAULTS) => ` ${l.label}${showPct(c) ? pctText(l) : ''} `

const limitWidth = (l: LimitCell, fit: LimitsFit, c: Config) =>
  (fit.overlay
    ? overlayText(l, c).length
    : l.label.length + (fit.bar ? 1 + fit.bar : 0) + (showPct(c) ? pctText(l).length : 0)) +
  (!l.reset || fit.reset === 'none' ? 0 : 4 + (fit.reset === 'short' ? shortReset(l.reset) : l.reset).length)

export const rowWidth = (hint: string, items: LimitCell[], fit: LimitsFit, c: Config = DEFAULTS) =>
  (fit.hint && hint ? hint.length + 5 : 0) +
  items.slice(0, fit.count).reduce((sum, l) => sum + limitWidth(l, fit, c), 0) +
  Math.max(0, fit.count - 1) * fit.sep.length

type Step = Omit<LimitsFit, 'hint' | 'count'>
const WIDE = '  │  '
const NARROW = ' │ '
const STEPS: Step[] = [
  ...Array.from({ length: 13 }, (_, k): Step => ({ bar: 20 - k, reset: 'full', sep: WIDE })),
  { bar: 8, reset: 'short', sep: WIDE },
  { bar: 6, reset: 'short', sep: NARROW },
  { bar: 0, overlay: true, reset: 'short', sep: NARROW },
  { bar: 0, overlay: true, reset: 'none', sep: NARROW },
]
const BARLESS: Step[] = [
  { bar: 0, reset: 'full', sep: WIDE },
  { bar: 0, reset: 'short', sep: WIDE },
  { bar: 0, reset: 'short', sep: NARROW },
  { bar: 0, reset: 'none', sep: NARROW },
]
const COMPACT: Step[] = BARLESS.map(s => ({ ...s, overlay: true }))

const stepsFor = (c: Config): Step[] => {
  const steps = !c.showBars ? BARLESS : c.layout === 'compact' ? COMPACT : STEPS
  return c.showResets ? steps : steps.map(s => ({ ...s, reset: 'none' }))
}

/**
 * Lays the limits out in `room` cells, giving up detail in this order: bar
 * length, the reset's minutes, the bar's own cells (it moves behind the text),
 * the reset, the engine's hint, then the last windows.
 */
export const fitLimits = (room: number, hint: string, items: LimitCell[], c: Config = DEFAULTS): LimitsFit => {
  const steps = stepsFor(c)
  for (const withHint of [true, false]) {
    for (const step of steps) {
      const fit = { ...step, hint: withHint, count: items.length }
      if (rowWidth(hint, items, fit, c) <= room) return fit
    }
  }
  const last: LimitsFit = { ...(steps[steps.length - 1] as Step), hint: false, count: items.length }
  while (last.count > 0 && rowWidth(hint, items, last, c) > room) last.count--
  return last
}

/** One terminal cell of a bar. */
export type Cell = { ch: string; fg?: string; bg?: string; bold?: boolean }

/** Neighbouring cells of one style merged, so a bar is a handful of Text runs. */
export const runs = (cells: Cell[]) => {
  const out: Cell[] = []
  for (const cell of cells) {
    const last = out[out.length - 1]
    if (last && last.fg === cell.fg && last.bg === cell.bg && last.bold === cell.bold) last.ch += cell.ch
    else out.push({ ...cell })
  }
  return out
}

/** One bar cell: `text` drawn on `color` in overlay mode, else the glyph, on a matching background when `solid`. */
const barCell = (c: Config, color: string, filled: boolean, glyph: string, text?: string): Cell =>
  text !== undefined
    ? { ch: text, fg: filled ? ON_FILL : ON_EMPTY, bg: color, bold: true }
    : { ch: glyph, fg: color, bg: c.style === 'solid' ? color : undefined }

/** The context bar's cells: each category's share, its label and percent on it in overlay mode. */
export const contextCells = (segs: Segment[], fit: ContextFit, percent: number, c: Config, f = 0): Cell[] => {
  const widths = cells(segs, fit.bar)
  const text = fit.overlay ? overlayContext(fit.label, percent, fit.bar, showPct(c)) : undefined
  const out: Cell[] = []
  segs.forEach((s, i) => {
    for (let n = 0; n < (widths[i] ?? 0); n++) {
      const k = out.length
      const used = s.kind === 'used'
      const base =
        s.kind === 'free' ? c.emptyColor : s.kind === 'buffer' ? BUFFER : c.contextColors === 'level' ? levelColor(percent, c) : s.color
      const color = used ? lighten(base, glow(c.animation, f, k)) : base
      out.push(barCell(c, color, used, used ? FULL : s.kind === 'buffer' ? MEDIUM : LIGHT, text?.[k]))
    }
  })
  return out
}

/** A limit's bar cells: `width` cells, the filled share in its level colour. */
export const limitCells = (l: LimitCell, width: number, c: Config, f = 0, text?: string): Cell[] => {
  const filled = Math.max(0, Math.min(width, Math.round((l.percent / 100) * width)))
  const level = levelColor(l.percent, c)
  return Array.from({ length: width }, (_, k) =>
    k < filled
      ? barCell(c, lighten(level, glow(c.animation, f, k)), true, FULL, text?.[k])
      : barCell(c, c.emptyColor, false, LIGHT, text?.[k]),
  )
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

/** What every session shares through the plugin's store, so they fetch once between them. */
type Shared = { reading?: Account; backoffUntil?: number; backoff?: number }

const SHARED_KEY = 'shared'

const readShared = async ($: EngineInterface): Promise<Shared> => {
  const v = await $.store.get(SHARED_KEY).catch(() => undefined)
  return v && typeof v === 'object' ? (v as Shared) : {}
}

/** The wait after a refusal: the server's `retry-after` when it gives one, else doubling from 5 min to 1 h. */
export const nextBackoff = (previous: number | undefined, retryAfter: string | undefined) => {
  const seconds = Number(retryAfter)
  if (retryAfter && Number.isFinite(seconds) && seconds > 0) return Math.min(BACKOFF_MOST, seconds * 1000)
  return previous ? Math.min(BACKOFF_MOST, previous * 2) : BACKOFF_FIRST
}

/** Windows whose reset has passed say nothing about now; the engine's figure stands in for them. */
export const current = (limits: Limit[], at: number) =>
  limits.filter(l => !l.resetsAt || !(Date.parse(l.resetsAt) <= at))

/**
 * Reads the account's windows, at most once every few minutes across all
 * sessions and never while the endpoint has asked to back off; the engine sets
 * the credential, the plugin never sees it.
 */
const fetchAccount = async ($: EngineInterface, force = false) => {
  const at = Date.now()
  const shared = await readShared($)
  const reading = shared.reading
  const age = reading ? at - reading.fetchedAt : Infinity
  const backingOff = (shared.backoffUntil ?? 0) > at
  if (backingOff || age < (force ? FORCE_GAP : FRESH_FOR)) {
    if (reading) await update($, account, () => reading)
    return
  }
  const auth = await $.session.authorize()
  if (!auth || auth.kind !== 'bearer') return
  const res = await $.http.fetch(USAGE_URL, {
    auth: auth.handle,
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
  })
  if (!res.ok) {
    const backoff = nextBackoff(shared.backoff, res.headers['retry-after'])
    await $.store.set(SHARED_KEY, { ...shared, backoff, backoffUntil: at + backoff })
    const raw = `HTTP ${res.status}: ${res.text.slice(0, 500)} (next try in ${Math.round(backoff / 60_000)} min)`
    await update($, account, a => ({ limits: a?.limits ?? reading?.limits ?? [], fetchedAt: a?.fetchedAt ?? 0, raw }))
    return
  }
  const fetched: Account = { limits: parseAccount(res.text), fetchedAt: at, raw: res.text }
  await $.store.set(SHARED_KEY, { reading: fetched })
  await update($, account, () => fetched)
}

export const register: Register = (on, options) => {
  config = readConfig(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await update($, now, () => Date.now())
    $.clock.every(30_000, () => void update($, now, () => Date.now()))
    $.clock.every(FETCH_EVERY, () => void fetchAccount($).catch(() => undefined))
    if (config.animation !== 'off') $.clock.every(FRAME_MS, () => void update($, frame, f => (f + 1) % 100_000))
    await $.command.register({ name: 'usage-bars', description: 'Show the raw usage figures the bars are drawn from' })
    void measure($).catch(() => undefined)
    void fetchAccount($).catch(() => undefined)
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
    const c = config
    const snap = c.showContext ? await read($, snapshot) : null
    if (e.props.hasSurvey || !snap) return next(e)
    const f = c.animation === 'off' ? 0 : await read($, frame)

    const { Box, Text } = $.ui.resolve(e)
    const percent = snap.percent ?? 0
    const level = levelColor(percent, c)
    const segs: Segment[] = snap.segments.length
      ? snap.segments
      : [
          { name: 'Used', tokens: snap.tokens ?? 0, color: c.okColor, kind: 'used' },
          { name: 'Free', tokens: Math.max(0, snap.window - (snap.tokens ?? 0)), color: c.emptyColor, kind: 'free' },
        ]
    const used = c.showLegend ? segs.filter(s => s.kind === 'used') : []
    const figures =
      c.showTokens && snap.tokens !== undefined ? `  ${compact(snap.tokens)}/${compact(snap.window)}` : ''
    // One cell spare: a row exactly as wide as the band wraps on some terminals.
    const fit = fitContext(e.props.bodyColumns - 1, used, figures, c)
    const bar = c.showBars ? runs(contextCells(segs, fit, percent, c, f)) : []

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
          {fit.overlay ? null : (
            <Text color={percent >= c.warnAt ? level : undefined} bold wrap="truncate">
              {fit.label}
            </Text>
          )}
          {bar.map((r, i) => (
            <Text key={`bar-${i}`} color={r.fg} backgroundColor={r.bg} bold={r.bold} wrap="truncate">
              {r.ch}
            </Text>
          ))}
          {fit.overlay || !showPct(c) ? null : (
            <Text color={level} bold wrap="truncate">
              {` ${Math.round(percent)}%`.padStart(PCT_WIDTH)}
            </Text>
          )}
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
    const c = config
    if (!c.showLimits) return next(e)
    const snap = await read($, snapshot)
    const acc = await read($, account)
    const at = (await read($, now)) || Date.now()
    const limits = mergeLimits(snap?.limits ?? [], current(acc?.limits ?? [], at))
    if (!limits.length) return next(e)
    const f = c.animation === 'off' ? 0 : await read($, frame)

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
    const fit = fitLimits((e.viewport?.columns ?? 120) - reserve, hint, items, c)
    if (!fit.count) return next(e)

    return (
      <Box flexDirection="row" flexWrap="nowrap">
        {fit.hint && hint ? <Text dimColor wrap="truncate">{`${hint}  ·  `}</Text> : null}
        {items.slice(0, fit.count).map((l, i) => {
          const color = levelColor(l.percent, c)
          const reset = fit.reset === 'none' ? '' : fit.reset === 'short' ? shortReset(l.reset) : l.reset
          const text = fit.overlay ? overlayText(l, c) : undefined
          const bar = runs(limitCells(l, text ? text.length : fit.bar, c, f, text))
          return (
            <Box key={`${l.label}-${i}`} flexDirection="row" flexShrink={0}>
              {i ? <Text dimColor>{fit.sep}</Text> : null}
              {text ? null : <Text bold>{fit.bar ? `${l.label} ` : l.label}</Text>}
              {bar.map((r, j) => (
                <Text key={`bar-${j}`} color={r.fg} backgroundColor={r.bg} bold={r.bold}>
                  {r.ch}
                </Text>
              ))}
              {text || !showPct(c) ? null : <Text color={color} bold>{pctText(l)}</Text>}
              {reset ? <Text dimColor>{`  ↻ ${reset}`}</Text> : null}
            </Box>
          )
        })}
      </Box>
    )
  })
}
