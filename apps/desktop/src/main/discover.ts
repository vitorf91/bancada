import { discoverWorkspace, loadConfig, resolveConfigPath } from '@bancada/workspace'
import type { DiscoveryResult } from '@bancada/workspace/types'

export interface DiscoverInput {
  env: Readonly<Record<string, string | undefined>>
  homeDir: string
}

/** Load the config and scan it. Never throws: a bad config or path is described in the result. */
export async function discover({ env, homeDir }: DiscoverInput): Promise<DiscoveryResult> {
  let configPath = ''
  try {
    configPath = resolveConfigPath({ env, homeDir })
    const loaded = await loadConfig(configPath, homeDir)
    return {
      configPath,
      configMissing: loaded.missing,
      products: await discoverWorkspace(loaded.config),
    }
  } catch (error) {
    return {
      configPath,
      configMissing: false,
      configError: error instanceof Error ? error.message : String(error),
      products: [],
    }
  }
}
