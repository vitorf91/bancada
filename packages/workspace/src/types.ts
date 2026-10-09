/**
 * Plain data shapes shared by the main process, the preload and the renderer.
 * No runtime code and no Node imports, so a renderer can import this file as `@bancada/workspace/types`.
 */

/** A project entry as written in the config: a folder on disk, optionally renamed. */
export interface ProjectConfig {
  /** Absolute path (a leading `~` is already expanded). */
  path: string
  name?: string
}

export interface ProductConfig {
  id: string
  name: string
  /** CSS color used for the product's accent in the UI. */
  color: string
  projects: ProjectConfig[]
}

export interface OptionsConfig {
  /** Where new worktrees are created. Unset means "next to the repo". Absolute path, `~` already expanded. */
  worktreeRoot?: string
  /** Globs matched against the absolute worktree path; matching worktrees start collapsed in the sidebar. */
  collapsedWorktrees: string[]
}

export interface WorkspaceConfig {
  products: ProductConfig[]
  options: OptionsConfig
}

/**
 * `main`: the repo's own checkout. `ephemeral-agent`: a throwaway worktree made by an agent
 * (under `.claude/worktrees/`). `regular`: any other linked worktree.
 */
export type WorktreeKind = 'main' | 'regular' | 'ephemeral-agent'

export interface Worktree {
  path: string
  /** Last path segment; for the main worktree this is the repo folder name. */
  name: string
  /** Short branch name (`feat/x`), or null when detached. */
  branch: string | null
  head: string
  detached: boolean
  locked: boolean
  /** Git considers the worktree stale (its folder is gone); `git worktree prune` would remove it. */
  prunable: boolean
  kind: WorktreeKind
  /** Matches one of `options.collapsedWorktrees`: the sidebar starts it collapsed. */
  collapsed: boolean
}

export interface DiscoveredRepo {
  path: string
  name: string
  worktrees: Worktree[]
  /** Set when git failed for this repo (the worktree list is then empty). */
  error?: string
}

/**
 * `repo`: the project path is a git repository.
 * `group`: a non-git folder that contains git repos up to 2 levels deep.
 * `folder`: a plain folder.
 * `error`: the path could not be read (missing, not a directory, ...).
 */
export type ProjectKind = 'repo' | 'group' | 'folder' | 'error'

export interface DiscoveredProject {
  path: string
  name: string
  kind: ProjectKind
  /** One entry for `repo`, one per inner repo for `group`, none otherwise. */
  repos: DiscoveredRepo[]
  error?: string
}

export interface DiscoveredProduct {
  id: string
  name: string
  color: string
  projects: DiscoveredProject[]
}

export interface DiscoveryResult {
  configPath: string
  /** True when the config file does not exist yet (the tree is then empty). */
  configMissing: boolean
  /** Set when the config exists but cannot be used; the tree is then empty. */
  configError?: string
  products: DiscoveredProduct[]
}
