import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Limit, Segment, Snapshot } from '../types'

const snapshot = atom({ plugin: 'usage-bars', key: 'snapshot' } as const, null)
const now = atom({ plugin: 'usage-bars', key: 'now' } as const, 0)

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

const LABEL_WIDTH = 9

export const levelColor = (percent: number) =>
  percent >= CRIT ? CRIT_FILL : percent >= WARN ? WARN_FILL : OK_FILL

/** `five_hour` → `5h`, `seven_day` → `Weekly`, `seven_day_fable` → `Fable wk`. */
export const limitLabel = (kind: string) => {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return 'Weekly'
  if (kind === 'spend_limit') return 'Spend'
  const model = /fable|opus|sonnet|haiku/i.exec(kind)?.[0]
  if (model) return `${model.charAt(0).toUpperCase()}${model.slice(1).toLowerCase()} wk`
  return kind.replace(/_/g, ' ')
}

const ORDER = ['five_hour', 'seven_day']
const rank = (kind: string) => (ORDER.includes(kind) ? ORDER.indexOf(kind) : ORDER.length)

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

const toLimits = (rateLimits: SessionRateLimit[]): Limit[] =>
  [...rateLimits]
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt }))

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await update($, now, () => Date.now())
    $.clock.every(30_000, () => void update($, now, () => Date.now()))
    void measure($).catch(() => undefined)
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) {
      await measure($).catch(() => undefined)
    } else {
      await update($, snapshot, s => (s ? { ...s, limits: toLimits(e.rateLimits) } : s))
    }
    await update($, now, () => Date.now())
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || !snap) return next(e)

    const at = (await read($, now)) || Date.now()
    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const barWidth = Math.max(10, Math.min(60, columns - LABEL_WIDTH - 26))

    const label = (text: string, color?: string) => (
      <Text color={color} bold>
        {text.padEnd(LABEL_WIDTH)}
      </Text>
    )
    const pct = (p: number) => (
      <Text color={levelColor(p)} bold>
        {` ${Math.round(p)}%`.padStart(5)}
      </Text>
    )

    const limitRows = snap.limits.map(l => {
      const filled = Math.max(0, Math.min(barWidth, Math.round((l.percent / 100) * barWidth)))
      const color = levelColor(l.percent)
      const reset = until(l.resetsAt, at)
      return (
        <Box key={l.kind} flexDirection="row">
          {label(limitLabel(l.kind))}
          <Text color={color}>{FULL.repeat(filled)}</Text>
          <Text color={EMPTY}>{LIGHT.repeat(barWidth - filled)}</Text>
          {pct(l.percent)}
          <Text dimColor>{reset ? `  ↻ ${reset}` : ''}</Text>
        </Box>
      )
    })

    const percent = snap.percent ?? 0
    const level = levelColor(percent)
    const segs: Segment[] = snap.segments.length
      ? snap.segments
      : [
          { name: 'Used', tokens: snap.tokens ?? 0, color: OK_FILL, kind: 'used' },
          { name: 'Free', tokens: Math.max(0, snap.window - (snap.tokens ?? 0)), color: EMPTY, kind: 'free' },
        ]
    const widths = cells(segs, barWidth)
    const used = segs.filter(s => s.kind === 'used')

    const contextRow = (
      <Box key="context" flexDirection="row">
        {label('Context', percent >= WARN ? level : undefined)}
        {segs.map((s, i) => (
          <Text key={`${s.name}-${i}`} color={s.kind === 'free' ? EMPTY : s.kind === 'buffer' ? BUFFER : s.color}>
            {(s.kind === 'used' ? FULL : s.kind === 'buffer' ? MEDIUM : LIGHT).repeat(widths[i] ?? 0)}
          </Text>
        ))}
        {pct(percent)}
        <Text dimColor>{snap.tokens !== undefined ? `  ${compact(snap.tokens)}/${compact(snap.window)}` : ''}</Text>
      </Box>
    )

    const legend = used.length ? (
      <Box key="legend" flexDirection="row" flexWrap="wrap">
        <Text>{' '.repeat(LABEL_WIDTH)}</Text>
        {used.map((s, i) => (
          <Text key={`${s.name}-${i}`} wrap="truncate">
            <Text color={s.color}>■ </Text>
            <Text dimColor>{`${s.name} ${compact(s.tokens)}  `}</Text>
          </Text>
        ))}
      </Box>
    ) : null

    return (
      <Box flexDirection="column">
        {limitRows}
        {contextRow}
        {legend}
      </Box>
    )
  })
}
