import { connectToHost, ensureHost } from '@bancada/pty-host'
import type { HostConnector } from './host-link.js'

export interface EnsureConnectorOptions {
  dataDir: string
  /** The pty-host bundle (`packages/pty-host/dist/pty-host.cjs`). */
  bundlePath: string
  /** The node-pty package dir `prepareRuntime` copies next to the bundle. */
  nodePtyDir: string
  /** Electron's binary: the host always runs in its node mode. */
  electronPath: string
  appVersion?: string
}

function isNoHost(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ECONNREFUSED'
}

/**
 * Every call returns a connection of its own. `ensureHost` is only used to get a host running: concurrent calls of
 * `ensureHost` share one client, and a client holds a single attach callback per session, so two phones watching the
 * same session would steal each other's stream.
 */
export function ensureHostConnector(options: EnsureConnectorOptions): HostConnector {
  return {
    async connect(clientName) {
      try {
        return await connectToHost(options.dataDir, { clientName })
      } catch (error) {
        if (!isNoHost(error)) throw error
      }
      const launcher = await ensureHost({ ...options, clientName: 'bancada-server-launch' })
      launcher.close()
      return connectToHost(options.dataDir, { clientName })
    },
  }
}
