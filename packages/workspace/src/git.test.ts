import { describe, expect, it } from 'vitest'
import { parseWorktreePorcelain } from './git.js'

describe('parseWorktreePorcelain', () => {
  it('parses main, branch, detached, locked and prunable records', () => {
    const output = [
      'worktree /code/acme-api',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /code/acme-api-login',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feat/login',
      'locked agent running',
      '',
      'worktree /code/acme-api-old',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n')
    const [main, login, old] = parseWorktreePorcelain(output)
    expect(main).toMatchObject({
      path: '/code/acme-api',
      branch: 'main',
      detached: false,
      locked: false,
      prunable: false,
    })
    expect(login).toMatchObject({ branch: 'feat/login', locked: true, prunable: false })
    expect(old).toMatchObject({ branch: null, detached: true, prunable: true })
  })

  it('marks bare repositories and unquotes C-style paths', () => {
    const [bare, odd] = parseWorktreePorcelain(
      'worktree /srv/x.git\nbare\n\nworktree "/code/caf\\303\\251"\nHEAD abc\ndetached\n',
    )
    expect(bare?.bare).toBe(true)
    expect(odd?.path).toBe('/code/café')
  })

  it('returns nothing for empty output', () => {
    expect(parseWorktreePorcelain('')).toEqual([])
  })
})
