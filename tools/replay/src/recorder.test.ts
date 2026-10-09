import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Asciicast, parseAsciicast } from './asciicast.js'
import { buildSessionEnv } from './session-env.js'

// The recorder only runs under Electron's binary in node mode. These tests go through the same launcher as
// `pnpm --filter @bancada/replay record`, so they also cover that path. Data dirs live under /tmp (socket path limit).
const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
let dir: string

beforeAll(() => {
  dir = mkdtempSync('/tmp/bancada-replay-')
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function record(args: string[]) {
  const result = spawnSync('node', [join(pkgRoot, 'scripts/record.mjs'), '--', ...args], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  })
  expect(result.stderr).toMatch(/recorded /)
  expect(result.status).toBe(0)
  return result
}

const outputOf = (cast: Asciicast): string =>
  cast.events
    .filter((e) => e.code === 'o')
    .map((e) => e.data)
    .join('')

describe('recorder (Electron node mode)', () => {
  it('records output with timestamps and scripted input', { timeout: 90_000 }, () => {
    const out = join(dir, 'cat.cast')
    const script = join(dir, 'input.json')
    writeFileSync(script, JSON.stringify([{ at: 0.6, data: 'ping\r' }]))
    record([
      '--out',
      out,
      '--cmd',
      'cat',
      '--cwd',
      dir,
      '--cols',
      '90',
      '--rows',
      '30',
      '--duration',
      '1.8',
      '--input-script',
      script,
    ])
    const cast = parseAsciicast(readFileSync(out, 'utf8'))
    expect(cast.header).toMatchObject({ version: 2, width: 90, height: 30, command: 'cat' })
    expect(cast.header.duration).toBeGreaterThan(1.7)
    const input = cast.events.filter((e) => e.code === 'i')
    expect(input).toHaveLength(1)
    expect(input[0]?.data).toBe('ping\r')
    expect(input[0]?.time).toBeGreaterThan(0.55)
    expect(outputOf(cast)).toContain('ping')
    for (let i = 1; i < cast.events.length; i++) {
      expect(cast.events[i]?.time).toBeGreaterThanOrEqual(cast.events[i - 1]?.time ?? 0)
    }
  })

  it('strips terminal-app and agent variables and does not leak the Electron switch', { timeout: 90_000 }, () => {
    const out = join(dir, 'env.cast')
    const names = 'ORCA_X CLAUDECODE CLAUDE_CODE_X TERM_PROGRAM ELECTRON_RUN_AS_NODE'
    record([
      '--out',
      out,
      '--cmd',
      `sh -c 'for n in ${names}; do eval "v=\\$$n"; printf "%s=[%s] " "$n" "$v"; done; echo; printf "TERM=%s " "$TERM"'`,
      '--cwd',
      dir,
      '--duration',
      '5',
    ])
    const text = outputOf(parseAsciicast(readFileSync(out, 'utf8')))
    // The parent test process may carry any of these; the recorded session must see none, and TERM_PROGRAM is reset.
    expect(text).toContain('ORCA_X=[]')
    expect(text).toContain('CLAUDECODE=[]')
    expect(text).toContain('CLAUDE_CODE_X=[]')
    expect(text).toContain('TERM_PROGRAM=[Bancada]')
    expect(text).toContain('ELECTRON_RUN_AS_NODE=[]')
    expect(text).toContain('TERM=xterm-256color')
  })

  it('can run the player as the command of a PTY session', { timeout: 90_000 }, () => {
    const out = join(dir, 'player.cast')
    const tiny = join(pkgRoot, 'fixtures/synthetic/tiny.cast')
    record([
      '--out',
      out,
      '--cmd',
      `node ${join(pkgRoot, 'dist/cli.mjs')} --file ${tiny} --speed 4`,
      '--cwd',
      dir,
      '--duration',
      '10',
    ])
    const cast = parseAsciicast(readFileSync(out, 'utf8'))
    // The tiny fixture's output events, concatenated, reach the terminal unchanged.
    expect(outputOf(cast)).toBe('hello \x1b[31mred\x1b[0m\x1b]0;title\x07\x1b[1;5Hbox ─ 你')
    expect(cast.header.duration).toBeLessThan(5)
    expect(cast.header.duration).toBeGreaterThan(0.55)
  })
})

describe('buildSessionEnv', () => {
  it('follows the hygiene list from docs/ARCHITECTURE.md', () => {
    const env = buildSessionEnv({
      PATH: '/usr/bin',
      ORCA_TAB_ID: 'x',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_PID: '1',
      CLAUDE_EFFORT: 'high',
      TERM_PROGRAM: 'iTerm.app',
      VSCODE_PID: '1',
      ITERM_SESSION_ID: 'x',
      GHOSTTY_RESOURCES_DIR: 'x',
      KITTY_WINDOW_ID: '1',
      WEZTERM_PANE: '1',
      TMUX: 'x',
      TMUX_PANE: '%1',
      ANTHROPIC_API_KEY: 'kept',
    })
    expect(Object.keys(env).sort()).toEqual(
      ['ANTHROPIC_API_KEY', 'COLORTERM', 'LANG', 'PATH', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION'].sort(),
    )
    expect(env).toMatchObject({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Bancada',
      LANG: 'en_US.UTF-8',
    })
  })

  it('keeps an existing LANG and applies extra variables last', () => {
    expect(buildSessionEnv({ LANG: 'pt_BR.UTF-8' }, { TERM: 'dumb' })).toMatchObject({
      LANG: 'pt_BR.UTF-8',
      TERM: 'dumb',
    })
  })
})
