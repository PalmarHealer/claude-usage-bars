import { expect, test } from 'claude-code/testing'

import { cells, compact, levelColor, limitLabel, until } from '../hooks/register'

test('labels the windows the account reports', () => {
  expect(limitLabel('five_hour')).toBe('5h')
  expect(limitLabel('seven_day')).toBe('Weekly')
  expect(limitLabel('seven_day_fable')).toBe('Fable wk')
  expect(limitLabel('seven_day_opus')).toBe('Opus wk')
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
