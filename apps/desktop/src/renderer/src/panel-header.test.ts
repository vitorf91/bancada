import { describe, expect, it } from 'vitest'
import { branchAddsInfo } from './panel-header.js'

describe('branchAddsInfo', () => {
  it('hides a branch that only repeats the worktree name', () => {
    expect(branchAddsInfo('login', 'login')).toBe(false)
    expect(branchAddsInfo('feat/login', 'login')).toBe(false)
    expect(branchAddsInfo('vitorf91/new-website', 'new-website')).toBe(false)
  })

  it('shows a branch that differs, and nothing when there is none', () => {
    expect(branchAddsInfo('main', 'acme-api')).toBe(true)
    expect(branchAddsInfo('feat/login', 'acme-api-login')).toBe(true)
    expect(branchAddsInfo(null, 'notes')).toBe(false)
    expect(branchAddsInfo('', 'notes')).toBe(false)
  })
})
