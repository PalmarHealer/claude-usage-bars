import { expect, test } from 'claude-code/testing'

import {
  cells,
  compact,
  current,
  fitContext,
  fitLimits,
  legendText,
  levelColor,
  limitLabel,
  mergeLimits,
  nextBackoff,
  parseAccount,
  rowWidth,
  until,
} from '../hooks/register'

test('labels the windows the account reports', () => {
  expect(limitLabel('five_hour')).toBe('5h')
  expect(limitLabel('seven_day')).toBe('Weekly')
  expect(limitLabel('seven_day_fable')).toBe('Fable')
  expect(limitLabel('seven_day_opus')).toBe('Opus')
})

test('colours by fill: blue, then orange from 70, red from 90', () => {
  expect(levelColor(10)).toBe('#5f87d7')
  expect(levelColor(75)).toBe('#ffaf00')
  expect(levelColor(95)).toBe('#ff5f5f')
})

test('splits the bar over the context categories exactly', () => {
  const widths = cells(
    [
      { name: 'System prompt', tokens: 300, color: 'a', kind: 'used' },
      { name: 'Messages', tokens: 50_000, color: 'b', kind: 'used' },
      { name: 'Free space', tokens: 120_000, color: 'c', kind: 'free' },
      { name: 'Autocompact buffer', tokens: 30_000, color: 'd', kind: 'buffer' },
    ],
    40,
  )
  expect(widths.reduce((a, b) => a + b, 0)).toBe(40)
  expect(widths[0]).toBe(1)
})

test('formats tokens and reset times', () => {
  expect(compact(200_000)).toBe('200k')
  expect(compact(1_000_000)).toBe('1M')
  const at = Date.parse('2026-11-11T10:00:00Z')
  expect(until('2026-11-11T12:14:00Z', at)).toBe('2h 14m')
  expect(until('2026-11-14T13:00:00Z', at)).toBe('3d 3h')
  expect(until(undefined, at)).toBe('')
})

test('reads every window the usage endpoint lists, per-model ones included', () => {
  const limits = parseAccount(
    JSON.stringify({
      five_hour: { utilization: 41, resets_at: '2026-11-11T12:00:00Z' },
      seven_day: { utilization: 76, resets_at: '2026-11-14T12:00:00Z' },
      seven_day_fable: { utilization: 92.5, resets_at: '2026-11-14T12:00:00Z' },
      seven_day_opus: null,
      seven_day_oauth_apps: { utilization: 0 },
      extra_usage: { is_enabled: false },
    }),
  )
  expect(limits.map(l => l.kind)).toEqual(['five_hour', 'seven_day', 'seven_day_fable'])
  const merged = mergeLimits([{ kind: 'five_hour', percent: 40 }, { kind: 'spend_limit', percent: 3 }], limits)
  expect(merged.map(l => `${l.kind}:${l.percent}`)).toEqual(['five_hour:41', 'seven_day:76', 'seven_day_fable:92.5', 'spend_limit:3'])
})

test('reads the model-scoped week from the limits list', () => {
  const limits = parseAccount(
    JSON.stringify({
      five_hour: { utilization: 11 },
      limits: [
        { kind: 'session', percent: 11, resets_at: '2026-11-11T02:40:00Z', scope: null },
        { kind: 'weekly_all', percent: 76, resets_at: '2026-11-14T01:00:00Z', scope: null },
        { kind: 'weekly_scoped', percent: 0, resets_at: '2026-11-14T01:00:00Z', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
      ],
    }),
  )
  expect(limits.map(l => `${limitLabel(l.kind)}:${l.percent}`)).toEqual(['5h:11', 'Weekly:76', 'Fable:0'])
})

test('keeps the context row inside narrow bands', () => {
  const used = [
    { name: 'System prompt', tokens: 2_000, color: 'a', kind: 'used' as const },
    { name: 'System tools', tokens: 38_000, color: 'b', kind: 'used' as const },
    { name: 'MCP server instructions', tokens: 4_000, color: 'c', kind: 'used' as const },
    { name: 'Messages', tokens: 260_000, color: 'd', kind: 'used' as const },
  ]
  const figures = '  306k/1M'
  for (const cols of [20, 40, 60, 80, 100, 140, 200]) {
    const fit = fitContext(cols, used, figures)
    const width =
      fit.label.length + fit.bar + 5 + (fit.showFigures ? figures.length : 0) +
      (fit.legend.length ? 3 + fit.legend.reduce((s, i) => s + legendText(used[i]!).length, 0) : 0)
    expect(width <= cols || fit.bar <= 10).toBe(true)
    expect(fit.bar >= 3).toBe(true)
  }
  expect(fitContext(200, used, figures).legend).toEqual([0, 1, 2, 3])
  const narrow = fitContext(60, used, figures)
  expect(narrow.legend).toContain(3)
  expect(narrow.second.length).toBeGreaterThan(0)
  expect(narrow.second.reduce((s, i) => s + legendText(used[i]!).length, 0)).toBeLessThanOrEqual(60)
})

test('gives up limit detail before it overflows the footer', () => {
  const items = [
    { label: '5h', percent: 12, reset: '2h 14m' },
    { label: 'Weekly', percent: 43, reset: '5d 13h' },
    { label: 'Fable', percent: 41, reset: '5d 13h' },
  ]
  const hint = 'esc to interrupt'
  for (let room = 0; room <= 160; room += 5) {
    const fit = fitLimits(room, hint, items)
    if (fit.count) expect(rowWidth(hint, items, fit)).toBeLessThanOrEqual(room)
  }
  const wide = fitLimits(160, hint, items)
  expect(wide.hint && wide.count === 3 && wide.reset === 'full' && wide.bar === 20).toBe(true)
  const tight = fitLimits(45, hint, items)
  expect(tight.count).toBe(3)
  expect(tight.hint).toBe(false)
})

test('backs off after a refusal and drops windows that have reset', () => {
  expect(nextBackoff(undefined, undefined)).toBe(5 * 60_000)
  expect(nextBackoff(5 * 60_000, undefined)).toBe(10 * 60_000)
  expect(nextBackoff(50 * 60_000, undefined)).toBe(60 * 60_000)
  expect(nextBackoff(undefined, '120')).toBe(120_000)
  const at = Date.parse('2026-11-14T12:00:00Z')
  const limits = [
    { kind: 'five_hour', percent: 80, resetsAt: '2026-11-14T11:00:00Z' },
    { kind: 'seven_day', percent: 43, resetsAt: '2026-11-19T14:00:00Z' },
  ]
  expect(current(limits, at).map(l => l.kind)).toEqual(['seven_day'])
})
