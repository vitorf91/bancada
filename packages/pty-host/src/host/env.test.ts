import { describe, expect, it } from 'vitest'
import { buildSessionEnv, commandExists, resolveCommand } from './env.js'

const base = { sessionId: 's1', profile: 'dev', appVersion: '1.2.3' }

describe('buildSessionEnv', () => {
  it('strips terminal-app and agent variables and keeps the rest', () => {
    const env = buildSessionEnv({
      ...base,
      hostEnv: {
        PATH: '/usr/bin',
        HOME: '/Users/x',
        ORCA_TEST: '1',
        ORCA_AGENT_HOOK_PORT: '1',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'a',
        CLAUDE_PID: '1',
        CLAUDE_EFFORT: 'high',
        VSCODE_PID: '1',
        ITERM_SESSION_ID: 'x',
        GHOSTTY_RESOURCES_DIR: 'x',
        KITTY_WINDOW_ID: '1',
        WEZTERM_PANE: '1',
        TMUX: 'x',
        TMUX_PANE: '%1',
        TERM_PROGRAM: 'iTerm.app',
        TERM_PROGRAM_VERSION: '9',
        ELECTRON_RUN_AS_NODE: '1',
        BANCADA_APP_VERSION: '9.9.9',
        BANCADA_DATA_DIR: '/tmp/x',
        CLAUDE_CONFIG_DIR: '/keep',
      },
    })
    expect(Object.keys(env).sort()).toEqual(
      [
        'BANCADA_PROFILE',
        'BANCADA_SESSION_ID',
        'CLAUDE_CONFIG_DIR',
        'COLORTERM',
        'HOME',
        'LANG',
        'PATH',
        'TERM',
        'TERM_PROGRAM',
        'TERM_PROGRAM_VERSION',
      ].sort(),
    )
  })

  it('sets the Bancada variables', () => {
    expect(buildSessionEnv({ ...base, hostEnv: { TERM: 'dumb' } })).toMatchObject({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Bancada',
      TERM_PROGRAM_VERSION: '1.2.3',
      LANG: 'en_US.UTF-8',
      BANCADA_SESSION_ID: 's1',
      BANCADA_PROFILE: 'dev',
    })
  })

  it('keeps an existing LANG', () => {
    expect(buildSessionEnv({ ...base, hostEnv: { LANG: 'pt_BR.UTF-8' } }).LANG).toBe('pt_BR.UTF-8')
  })

  it('applies spec.env last', () => {
    const env = buildSessionEnv({ ...base, hostEnv: {}, specEnv: { TERM: 'screen', FOO: 'bar', ORCA_X: 'explicit' } })
    expect(env).toMatchObject({ TERM: 'screen', FOO: 'bar', ORCA_X: 'explicit' })
  })
})

describe('resolveCommand', () => {
  it('defaults to the login shell with -l', () => {
    expect(resolveCommand({}, { SHELL: '/bin/fish' })).toEqual({ command: '/bin/fish', args: ['-l'] })
  })

  it('does not add -l to an explicit command', () => {
    expect(resolveCommand({ command: 'claude', args: ['--resume'] }, { SHELL: '/bin/fish' })).toEqual({
      command: 'claude',
      args: ['--resume'],
    })
    expect(resolveCommand({ command: 'htop' }, {})).toEqual({ command: 'htop', args: [] })
  })
})

describe('commandExists', () => {
  it('finds bare names in PATH and explicit paths', () => {
    expect(commandExists('sh', '/tmp', '/nope:/bin')).toBe(true)
    expect(commandExists('/bin/sh', '/tmp', undefined)).toBe(true)
    expect(commandExists('../bin/sh', '/tmp', undefined)).toBe(true)
  })

  it('rejects missing, non-executable and directory commands', () => {
    expect(commandExists('no-such-command-xyz', '/tmp', '/bin:/usr/bin')).toBe(false)
    expect(commandExists('sh', '/tmp', undefined)).toBe(false)
    expect(commandExists('/etc/hosts', '/tmp', undefined)).toBe(false)
    expect(commandExists('/bin', '/tmp', undefined)).toBe(false)
  })
})
