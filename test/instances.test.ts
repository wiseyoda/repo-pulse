import { describe, expect, it } from 'vitest'
import { formatDuration, parseDuration, shouldStop, stopsAt } from '../src/instances.ts'

describe('parseDuration', () => {
  it('reads minutes, hours, days, and the off words', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000)
    expect(parseDuration('2h')).toBe(2 * 3_600_000)
    expect(parseDuration('1.5h')).toBe(90 * 60_000)
    expect(parseDuration('1d')).toBe(86_400_000)
    expect(parseDuration('90')).toBe(90 * 60_000)
    expect(parseDuration('off')).toBe(0)
    expect(parseDuration('never')).toBe(0)
    expect(parseDuration('soon')).toBeNull()
  })
  it('formats back readably', () => {
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(5 * 60_000)).toBe('5m')
    expect(formatDuration(150 * 60_000)).toBe('2h 30m')
    expect(formatDuration(3 * 86_400_000)).toBe('3d')
  })
})

describe('idle stop rule', () => {
  const H = 3_600_000
  it('never stops while a page is connected or when idle is off', () => {
    expect(stopsAt(10 * H, 2 * H, 1, 0, 0, 0)).toBeNull()
    expect(stopsAt(10 * H, 0, 0, 0, 0, 0)).toBeNull()
  })
  it('counts from the later of last viewer, last event, and start', () => {
    expect(stopsAt(10 * H, 2 * H, 0, 3 * H, 5 * H, 0)).toBe(7 * H)
    expect(stopsAt(10 * H, 2 * H, 0, 0, 0, 9 * H)).toBe(11 * H)
  })
  it('stops once the budget has passed with nobody watching', () => {
    expect(shouldStop(7 * H - 1, 2 * H, 0, 3 * H, 5 * H, 0)).toBe(false)
    expect(shouldStop(7 * H, 2 * H, 0, 3 * H, 5 * H, 0)).toBe(true)
    expect(shouldStop(7 * H, 2 * H, 2, 3 * H, 5 * H, 0)).toBe(false)
  })
})
