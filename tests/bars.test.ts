import { expect, test } from 'claude-code/testing'

import { cells, compact, levelColor, limitLabel, mergeLimits, parseAccount, until } from '../hooks/register'

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
