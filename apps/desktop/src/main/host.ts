import { createRequire } from 'node:module'
import path from 'node:path'
import { ensureHost, type PtyClient } from '@bancada/pty-host'
import { app } from 'electron'

export interface HostPaths {
  /** The esbuild output of `packages/pty-host` (`pnpm --filter @bancada/pty-host build`). */
  bundlePath: string
  /** The node-pty package the host loads. */
  nodePtyDir: string
}

/**
 * Where the host bundle and node-pty come from. Dev, e2e and bench resolve them from the workspace: the bundle is
 * the built `packages/pty-host/dist/pty-host.cjs` and node-pty is the copy that package resolves (pnpm's strict
 * layout puts it next to pty-host, not next to the desktop app). `prepareRuntime` copies both into the data dir, so
 * a rebuild or a deleted `dist/` never touches a running host. Packaged builds will point these at app resources.
 */
export function resolveHostPaths(env: NodeJS.ProcessEnv = process.env): HostPaths {
  const require = createRequire(import.meta.url)
  // pty-host exports only its TypeScript entry (src/index.ts), so its root is two levels up from it.
  const ptyHostRoot = path.resolve(path.dirname(require.resolve('@bancada/pty-host')), '..')
  const bundlePath = env.BANCADA_PTY_HOST_BUNDLE || path.join(ptyHostRoot, 'dist', 'pty-host.cjs')
  const nodePtyDir =
    env.BANCADA_NODE_PTY_DIR ||
    path.dirname(createRequire(path.join(ptyHostRoot, 'package.json')).resolve('node-pty/package.json'))
  return { bundlePath, nodePtyDir }
}

/** The client of this profile's pty-host, launching the host (under Electron's own binary in node mode) when needed. */
export function connectToPtyHost(dataDir: string): Promise<PtyClient> {
  return ensureHost({
    dataDir,
    ...resolveHostPaths(),
    electronPath: process.execPath,
    appVersion: app.getVersion(),
    clientName: 'desktop',
  })
}
