import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { STRIPPED_ENV_NAMES, STRIPPED_ENV_PREFIXES } from '@bancada/protocol'

/**
 * Session environment hygiene (docs/ARCHITECTURE.md, "Session environment hygiene"). Pure: the host's env and
 * the identity of the session are parameters.
 */

/**
 * Host-only variables that must never reach a session. `ELECTRON_RUN_AS_NODE` is how the host itself runs: a
 * session that inherited it would turn every Electron app started from the terminal into a plain Node process.
 * `BANCADA_DATA_DIR` would pin a Bancada started inside a session to the host's data dir (it overrides the profile).
 */
const HOST_ONLY_ENV_NAMES = ['ELECTRON_RUN_AS_NODE', 'BANCADA_APP_VERSION', 'BANCADA_DATA_DIR'] as const

export interface SessionEnvInput {
  hostEnv: Readonly<Record<string, string | undefined>>
  sessionId: string
  profile: string
  appVersion: string
  specEnv?: Readonly<Record<string, string>>
}

export function isStrippedEnvName(name: string): boolean {
  return (
    (STRIPPED_ENV_NAMES as readonly string[]).includes(name) ||
    (HOST_ONLY_ENV_NAMES as readonly string[]).includes(name) ||
    STRIPPED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  )
}

export function buildSessionEnv({
  hostEnv,
  sessionId,
  profile,
  appVersion,
  specEnv,
}: SessionEnvInput): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(hostEnv)) {
    if (value !== undefined && !isStrippedEnvName(name)) env[name] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'Bancada'
  env.TERM_PROGRAM_VERSION = appVersion
  if (!env.LANG) env.LANG = 'en_US.UTF-8'
  env.BANCADA_SESSION_ID = sessionId
  env.BANCADA_PROFILE = profile
  if (specEnv) Object.assign(env, specEnv)
  return env
}

/** The user's login shell: `$SHELL`, falling back to the account's shell, then zsh (macOS default). */
export function resolveLoginShell(hostEnv: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = hostEnv.SHELL?.trim()
  if (fromEnv) return fromEnv
  try {
    const fromAccount = os.userInfo().shell
    if (fromAccount) return fromAccount
  } catch {
    // userInfo throws when the uid has no passwd entry
  }
  return '/bin/zsh'
}

/** `command` and `args` for a spawn: the login shell with `-l` unless the caller chose a command. */
export function resolveCommand(
  spec: { command?: string; args?: string[] },
  hostEnv: Readonly<Record<string, string | undefined>>,
): { command: string; args: string[] } {
  if (spec.command) return { command: spec.command, args: spec.args ?? [] }
  return { command: resolveLoginShell(hostEnv), args: spec.args ?? ['-l'] }
}

/** Whether `command` names an executable file, looked up like a shell would (a path as is, a bare name in PATH). */
export function commandExists(command: string, cwd: string, searchPath: string | undefined): boolean {
  const isExecutable = (file: string): boolean => {
    try {
      if (!fs.statSync(file).isFile()) return false
      fs.accessSync(file, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (command.includes('/')) return isExecutable(path.resolve(cwd, command))
  return (searchPath ?? '').split(':').some((dir) => dir !== '' && isExecutable(path.join(dir, command)))
}
