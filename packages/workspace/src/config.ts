import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'smol-toml'
import type { OptionsConfig, ProductConfig, ProjectConfig, WorkspaceConfig } from './types.js'

export const DEFAULT_COLLAPSED_WORKTREES: readonly string[] = ['**/.claude/worktrees/**']

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

export interface ConfigPathInput {
  env: Readonly<Record<string, string | undefined>>
  homeDir: string
}

/** `BANCADA_CONFIG` (tests), or `~/.config/bancada/config.toml`. */
export function resolveConfigPath({ env, homeDir }: ConfigPathInput): string {
  const override = env.BANCADA_CONFIG?.trim()
  if (override) {
    if (!path.isAbsolute(override))
      throw new ConfigError(`BANCADA_CONFIG must be an absolute path, got ${JSON.stringify(override)}`)
    return path.resolve(override)
  }
  return path.join(homeDir, '.config', 'bancada', 'config.toml')
}

/** Expand a leading `~` and require an absolute path. */
export function expandPath(value: string, homeDir: string, where: string): string {
  let expanded = value
  if (value === '~') expanded = homeDir
  else if (value.startsWith('~/')) expanded = path.join(homeDir, value.slice(2))
  if (!path.isAbsolute(expanded)) {
    throw new ConfigError(`${where}: expected an absolute path or one starting with "~/", got ${JSON.stringify(value)}`)
  }
  return path.normalize(expanded).replace(/(.)\/+$/, '$1')
}

type Table = Record<string, unknown>

function isTable(value: unknown): value is Table {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

function requireString(table: Table, key: string, where: string): string {
  const value = table[key]
  if (typeof value !== 'string' || value.trim() === '')
    throw new ConfigError(`${where}.${key}: expected a non-empty string`)
  return value.trim()
}

function optionalString(table: Table, key: string, where: string): string | undefined {
  const value = table[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '')
    throw new ConfigError(`${where}.${key}: expected a non-empty string`)
  return value.trim()
}

function parseProject(raw: unknown, where: string, homeDir: string): ProjectConfig {
  if (!isTable(raw)) throw new ConfigError(`${where}: expected a table with a "path"`)
  const project: ProjectConfig = { path: expandPath(requireString(raw, 'path', where), homeDir, `${where}.path`) }
  const name = optionalString(raw, 'name', where)
  if (name !== undefined) project.name = name
  return project
}

function parseProduct(raw: unknown, index: number, homeDir: string): ProductConfig {
  const where = `products[${index}]`
  if (!isTable(raw)) throw new ConfigError(`${where}: expected a table`)
  const id = requireString(raw, 'id', where)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new ConfigError(`${where}.id: use letters, digits, "-" and "_" only, got ${JSON.stringify(id)}`)
  }
  const rawProjects = raw.projects ?? []
  if (!Array.isArray(rawProjects)) throw new ConfigError(`${where}.projects: expected an array of tables`)
  return {
    id,
    name: requireString(raw, 'name', where),
    color: requireString(raw, 'color', where),
    projects: rawProjects.map((p, i) => parseProject(p, `${where}.projects[${i}]`, homeDir)),
  }
}

function parseOptions(raw: unknown, homeDir: string): OptionsConfig {
  if (raw !== undefined && !isTable(raw)) throw new ConfigError('options: expected a table')
  const table = raw ?? {}
  const options: OptionsConfig = { collapsedWorktrees: [...DEFAULT_COLLAPSED_WORKTREES] }
  const root = optionalString(table, 'worktreeRoot', 'options')
  if (root !== undefined) options.worktreeRoot = expandPath(root, homeDir, 'options.worktreeRoot')
  const globs = table.collapsedWorktrees
  if (globs !== undefined) {
    if (!Array.isArray(globs) || globs.some((g) => typeof g !== 'string')) {
      throw new ConfigError('options.collapsedWorktrees: expected an array of glob strings')
    }
    options.collapsedWorktrees = globs as string[]
  }
  return options
}

/** Parse and validate config TOML. Throws {@link ConfigError} with a readable message. */
export function parseConfig(source: string, homeDir: string): WorkspaceConfig {
  let doc: Table
  try {
    doc = parse(source)
  } catch (error) {
    throw new ConfigError(`Invalid TOML: ${error instanceof Error ? error.message : String(error)}`)
  }
  const rawProducts = doc.products ?? []
  if (!Array.isArray(rawProducts)) throw new ConfigError('products: expected an array of tables ([[products]])')
  const products = rawProducts.map((p, i) => parseProduct(p, i, homeDir))
  const seen = new Set<string>()
  for (const product of products) {
    if (seen.has(product.id)) throw new ConfigError(`products: duplicate id ${JSON.stringify(product.id)}`)
    seen.add(product.id)
  }
  return { products, options: parseOptions(doc.options, homeDir) }
}

export interface LoadedConfig {
  configPath: string
  /** The file does not exist; `config` is the empty default. */
  missing: boolean
  config: WorkspaceConfig
}

export function emptyConfig(): WorkspaceConfig {
  return { products: [], options: { collapsedWorktrees: [...DEFAULT_COLLAPSED_WORKTREES] } }
}

/** Read the config file. A missing file is not an error (first run); an unreadable or invalid one throws. */
export async function loadConfig(configPath: string, homeDir: string): Promise<LoadedConfig> {
  let source: string
  try {
    source = await readFile(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { configPath, missing: true, config: emptyConfig() }
    throw new ConfigError(`Cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { configPath, missing: false, config: parseConfig(source, homeDir) }
}
