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

export const levelColor = (percent: number) =>
  percent >= CRIT ? CRIT_FILL : percent >= WARN ? WARN_FILL : OK_FILL

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

/**
 * The usage endpoint's windows: every `five_hour`/`seven_day*` entry that is
 * set and carries a utilization, so a per-model window (Fable, Opus) shows up
 * under whatever key the account has it.
 */
export const parseAccount = (text: string): Limit[] => {
  const body = JSON.parse(text) as Record<string, unknown>
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
    const barWidth = Math.max(10, Math.min(60, e.props.bodyColumns - 9 - 22))
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

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={percent >= WARN ? level : undefined} bold>
            {'Context  '}
          </Text>
          {segs.map((s, i) => (
            <Text key={`${s.name}-${i}`} color={s.kind === 'free' ? EMPTY : s.kind === 'buffer' ? BUFFER : s.color}>
              {(s.kind === 'used' ? FULL : s.kind === 'buffer' ? MEDIUM : LIGHT).repeat(widths[i] ?? 0)}
            </Text>
          ))}
          <Text color={level} bold>
            {` ${Math.round(percent)}%`.padStart(5)}
          </Text>
          <Text dimColor>{snap.tokens !== undefined ? `  ${compact(snap.tokens)}/${compact(snap.window)}` : ''}</Text>
        </Box>
        {used.length ? (
          <Box flexDirection="row" flexWrap="wrap">
            <Text>{'         '}</Text>
            {used.map((s, i) => (
              <Text key={`${s.name}-${i}`} wrap="truncate">
                <Text color={s.color}>■ </Text>
                <Text dimColor>{`${s.name} ${compact(s.tokens)}  `}</Text>
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    )
  })

  // Limits side by side under the prompt, the engine's hint line kept beneath.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    const acc = await read($, account)
    const limits = mergeLimits(snap?.limits ?? [], acc?.limits ?? [])
    if (!limits.length) return next(e)

    const at = (await read($, now)) || Date.now()
    const { Box, Text } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 120
    const barWidth = Math.max(6, Math.min(20, Math.floor((columns - 4) / limits.length) - 24))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {limits.map((l, i) => {
            const filled = Math.max(0, Math.min(barWidth, Math.round((l.percent / 100) * barWidth)))
            const color = levelColor(l.percent)
            const reset = until(l.resetsAt, at)
            return (
              <Box key={l.kind} flexDirection="row">
                <Text dimColor>{i ? '  │  ' : ''}</Text>
                <Text bold>{`${limitLabel(l.kind)} `}</Text>
                <Text color={color}>{FULL.repeat(filled)}</Text>
                <Text color={EMPTY}>{LIGHT.repeat(barWidth - filled)}</Text>
                <Text color={color} bold>{` ${Math.round(l.percent)}%`}</Text>
                <Text dimColor>{reset ? ` ↻${reset}` : ''}</Text>
              </Box>
            )
          })}
        </Box>
        <Text dimColor wrap="truncate">
          {e.props.hint}
        </Text>
      </Box>
    )
  })
}
