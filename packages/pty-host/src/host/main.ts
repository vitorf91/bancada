import os from 'node:os'
import { resolveDataDir, resolveHostLogPath } from '@bancada/protocol/paths'
import { version as hostVersion } from '../../package.json'
import { HostAlreadyRunningError } from './lock.js'
import { createLogger } from './log.js'
import { HostServer } from './server.js'

/** Entry point of the bundled pty-host. Runs under Electron's binary in node mode, detached from whoever launched it. */
async function main(): Promise<void> {
  const dataDir = resolveDataDir({ env: process.env, homeDir: os.homedir() })
  const logger = createLogger(resolveHostLogPath(dataDir))
  const server = new HostServer({
    dataDir,
    hostVersion,
    appVersion: process.env.BANCADA_APP_VERSION ?? hostVersion,
    env: process.env,
    logger,
  })

  try {
    await server.start()
  } catch (error) {
    if (error instanceof HostAlreadyRunningError) {
      logger.warn('another pty-host owns this data dir; exiting', { holder: error.pid })
      process.stderr.write(`pty-host: ${error.message}\n`)
      process.exit(3)
    }
    logger.error('pty-host failed to start', {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    })
    process.stderr.write(`pty-host: failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }

  // SIGTERM / SIGINT end the host and every session, as a forced shutdown does; SIGHUP is ignored.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void server.shutdown(signal))
  process.on('SIGHUP', () => {})
  // A bug in one connection must not end every terminal.
  process.on('uncaughtException', (error) =>
    logger.error('uncaught exception', { error: error.stack ?? String(error) }),
  )
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { reason: String(reason) }))

  await server.closed
  process.exit(0)
}

void main()
