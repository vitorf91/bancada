import { describe, expect, it } from 'vitest'
import { WebglBudget } from './webgl-budget.js'

function track(budget: WebglBudget, ids: string[]) {
  const state = new Map<string, boolean>()
  const unregister = ids.map((id) => budget.register(id, (granted) => state.set(id, granted)))
  return { state, unregister }
}

describe('WebglBudget', () => {
  it('grants the first N registered terminals and no more', () => {
    const budget = new WebglBudget(2)
    const { state } = track(budget, ['a', 'b', 'c'])
    expect(budget.isGranted('a')).toBe(true)
    expect(budget.isGranted('b')).toBe(true)
    expect(budget.isGranted('c')).toBe(false)
    expect(state.get('c')).toBeUndefined()
  })

  it('moves a slot to the terminal that gains focus, taking it from the least recent one', () => {
    const budget = new WebglBudget(2)
    const { state } = track(budget, ['a', 'b', 'c'])
    budget.touch('c')
    expect(state.get('c')).toBe(true)
    expect(state.get('b')).toBe(false)
    expect(budget.isGranted('a')).toBe(true)
    budget.touch('b')
    expect(budget.isGranted('b')).toBe(true)
    expect(budget.isGranted('a')).toBe(false)
  })

  it('gives the slot of a hidden terminal to the next one and takes it back as the least recent', () => {
    const budget = new WebglBudget(1)
    const { state } = track(budget, ['a', 'b'])
    budget.setVisible('a', false)
    expect(state.get('a')).toBe(false)
    expect(state.get('b')).toBe(true)
    budget.setVisible('a', true)
    expect(budget.isGranted('b')).toBe(true)
    expect(budget.isGranted('a')).toBe(false)
  })

  it('never regrants a terminal that lost its context', () => {
    const budget = new WebglBudget(1)
    track(budget, ['a', 'b'])
    budget.markLost('a')
    expect(budget.isGranted('a')).toBe(false)
    expect(budget.isGranted('b')).toBe(true)
    budget.touch('a')
    expect(budget.isGranted('a')).toBe(false)
  })

  it('frees the slot when a terminal unregisters, and follows limit changes', () => {
    const budget = new WebglBudget(1)
    const { unregister } = track(budget, ['a', 'b'])
    unregister[0]?.()
    expect(budget.isGranted('b')).toBe(true)
    budget.setLimit(0)
    expect(budget.isGranted('b')).toBe(false)
    budget.setLimit(Number.POSITIVE_INFINITY)
    expect(budget.isGranted('b')).toBe(true)
  })
})
