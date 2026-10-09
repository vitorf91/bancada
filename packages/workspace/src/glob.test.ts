import { describe, expect, it } from 'vitest'
import { globToRegExp, matchesAnyGlob } from './glob.js'

describe('globToRegExp', () => {
  it('matches the default agent-worktree glob at any depth', () => {
    const glob = ['**/.claude/worktrees/**']
    expect(matchesAnyGlob(glob, '/code/acme/.claude/worktrees/agent-1')).toBe(true)
    expect(matchesAnyGlob(glob, '/.claude/worktrees/agent-1')).toBe(true)
    expect(matchesAnyGlob(glob, '/code/acme/.claude/worktrees')).toBe(true)
    expect(matchesAnyGlob(glob, '/code/acme/worktrees/agent-1')).toBe(false)
    expect(matchesAnyGlob(glob, '/code/acme-claude/worktrees/x')).toBe(false)
  })

  it('keeps * inside one segment and treats regex characters literally', () => {
    expect(globToRegExp('/code/*/api').test('/code/acme/api')).toBe(true)
    expect(globToRegExp('/code/*/api').test('/code/a/b/api')).toBe(false)
    expect(globToRegExp('/code/a.b').test('/code/axb')).toBe(false)
    expect(globToRegExp('/code/a?').test('/code/ab')).toBe(true)
  })
})
