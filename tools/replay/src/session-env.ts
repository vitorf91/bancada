import { STRIPPED_ENV_NAMES, STRIPPED_ENV_PREFIXES } from '@bancada/protocol'

/**
 * Builds the environment a recorded session runs in, following "Session environment hygiene" in
 * docs/ARCHITECTURE.md: the host's variables minus the terminal-app and agent ones, plus the terminal identity.
 */
export function buildSessionEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
  appVersion = '0.0.0',
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if ((STRIPPED_ENV_NAMES as readonly string[]).includes(key)) continue
    if (STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'Bancada'
  env.TERM_PROGRAM_VERSION = appVersion
  env.LANG ??= 'en_US.UTF-8'
  return { ...env, ...extra }
}
