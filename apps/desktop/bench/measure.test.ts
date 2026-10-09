import { describe, expect, it } from 'vitest'
import { averageCpu, latencyStats, parseCpuTime, percentile } from './measure.js'

describe('bench measurements', () => {
  it('parses ps CPU times', () => {
    expect(parseCpuTime('  0:12.34')).toBeCloseTo(12.34)
    expect(parseCpuTime('1:02:03.50')).toBeCloseTo(3723.5)
  })

  it('computes nearest-rank percentiles', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(values, 50)).toBe(50)
    expect(percentile(values, 95)).toBe(95)
    expect(percentile(values, 99)).toBe(99)
    expect(latencyStats([5, 1, 3])).toMatchObject({ n: 3, p50: 3, max: 5 })
    expect(percentile([], 95)).toBe(0)
  })

  it('averages CPU per role over the samples', () => {
    const cpu = averageCpu([
      [
        { type: 'Tab', cpu: 10 },
        { type: 'GPU', cpu: 4 },
        { type: 'Browser', cpu: 2 },
        { type: 'Utility', cpu: 1 },
      ],
      [
        { type: 'Tab', cpu: 30 },
        { type: 'Tab', cpu: 10 },
        { type: 'GPU', cpu: 8 },
        { type: 'Browser', cpu: 4 },
      ],
    ])
    expect(cpu).toEqual({ renderer: 25, gpu: 6, main: 3, other: 0.5 })
  })
})
