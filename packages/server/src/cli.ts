import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { resolveDataDir, resolveProfile } from '@bancada/protocol/paths'
import QRCode from 'qrcode'
import { ensureHostConnector } from './connector.js'
import { ControlError, controlRequest } from './control-client.js'
import type { DeviceInfo } from './devices.js'
import { resolveControlSocketPath } from './paths.js'
import { FileSecretStore, KeychainSecretStore, type SecretStore } from './secrets.js'
import { DEFAULT_PORT, startServer } from './server.js'

const USAGE = `usage: server <command>
  start                      run the server (public API on 127.0.0.1, control socket in the data dir)
  pair                       print a one-time pairing code and a QR for the phone
  devices                    list paired devices
  revoke <id>                revoke a device now (open sockets close)
  notify [--session <id>] [--] <text>   send a push to every device`

function parsePort(env: NodeJS.ProcessEnv): number {
  const raw = env.BANCADA_SERVER_PORT?.trim()
  if (!raw) return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid BANCADA_SERVER_PORT: ${raw}`)
  return port
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is not set (run the server through "pnpm --filter @bancada/server start")`)
  return value
}

function vapidStore(env: NodeJS.ProcessEnv): SecretStore {
  if (env.BANCADA_VAPID_FILE) return new FileSecretStore(env.BANCADA_VAPID_FILE)
  return new KeychainSecretStore(`vapid-${resolveProfile(env)}`)
}

async function start(env: NodeJS.ProcessEnv): Promise<void> {
  const dataDir = resolveDataDir({ env, homeDir: homedir() })
  const log = (message: string): void => console.log(`${new Date().toISOString()} ${message}`)
  const server = await startServer({
    dataDir,
    port: parsePort(env),
    pwaDir: env.BANCADA_PWA_DIR ? path.resolve(env.BANCADA_PWA_DIR) : undefined,
    vapidStore: vapidStore(env),
    vapidSubject: env.BANCADA_VAPID_SUBJECT || undefined,
    connector: ensureHostConnector({
      dataDir,
      bundlePath: requireEnv(env, 'BANCADA_PTY_HOST_BUNDLE'),
      nodePtyDir: requireEnv(env, 'BANCADA_NODE_PTY_DIR'),
      electronPath: process.execPath,
      appVersion: env.BANCADA_APP_VERSION,
    }),
    log,
  })
  log(`ready (profile ${resolveProfile(env)})`)
  const stop = (): void => {
    void server.close().finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

function execText(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5000, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout))
  })
}

/** The URL the phone opens: `BANCADA_PUBLIC_URL`, else this Mac's tailnet name, else the local address. */
async function publicBaseUrl(env: NodeJS.ProcessEnv, port: number): Promise<{ url: string; tailnet: boolean }> {
  if (env.BANCADA_PUBLIC_URL) return { url: env.BANCADA_PUBLIC_URL.replace(/\/+$/, ''), tailnet: true }
  for (const bin of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    const out = await execText(bin, ['status', '--json'])
    if (!out) continue
    try {
      const dns = (JSON.parse(out) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, '')
      if (dns) return { url: `https://${dns}`, tailnet: true }
    } catch {
      // try the next binary
    }
  }
  return { url: `http://127.0.0.1:${port}`, tailnet: false }
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = argv
  if (command === 'start') {
    await start(env)
    return -1 // keep running
  }
  if (!command || !['pair', 'devices', 'revoke', 'notify'].includes(command)) {
    console.error(USAGE)
    return 2
  }

  const dataDir = resolveDataDir({ env, homeDir: homedir() })
  const socket = resolveControlSocketPath(dataDir, process.getuid?.() ?? 0)
  try {
    if (command === 'pair') {
      const status = await controlRequest<{ port: number }>(socket, 'GET', '/v1/status')
      const { code, ttlSeconds } = await controlRequest<{ code: string; ttlSeconds: number }>(
        socket,
        'POST',
        '/v1/pairing',
      )
      const base = await publicBaseUrl(env, status.port)
      const url = `${base.url}/#/pair/${code.replace('-', '')}`
      console.log(await QRCode.toString(url, { type: 'terminal', small: true }))
      console.log(`Pairing code: ${code}   (single use, expires in ${Math.round(ttlSeconds / 60)} min)`)
      console.log(`URL:          ${url}`)
      if (!base.tailnet) {
        console.log(
          '\nNo Tailscale name found: this URL only works on this Mac. See docs/proofs/F0-d.md for `tailscale serve`.',
        )
      }
      return 0
    }
    if (command === 'devices') {
      const { devices } = await controlRequest<{ devices: (DeviceInfo & { push: boolean })[] }>(
        socket,
        'GET',
        '/v1/devices',
      )
      if (devices.length === 0) console.log('No paired devices.')
      for (const d of devices) {
        console.log(
          `${d.id.slice(0, 8)}  ${d.name.padEnd(20)} paired ${formatTime(d.createdAt)}  last seen ${formatTime(d.lastSeenAt)}  push ${d.push ? 'on' : 'off'}`,
        )
      }
      return 0
    }
    if (command === 'revoke') {
      const id = rest[0]
      if (!id) {
        console.error('usage: revoke <id>')
        return 2
      }
      await controlRequest(socket, 'DELETE', `/v1/devices/${encodeURIComponent(id)}`)
      console.log('Revoked. Open connections of that device are closed.')
      return 0
    }
    // notify
    const args = rest.filter((a, i) => !(a === '--' && i === rest.indexOf('--')))
    let sessionId: string | undefined
    const si = args.indexOf('--session')
    if (si >= 0) {
      sessionId = args[si + 1]
      args.splice(si, 2)
    }
    const text = args.join(' ').trim()
    if (!text) {
      console.error('usage: notify [--session <id>] [--] <text>')
      return 2
    }
    const result = await controlRequest<{ sent: number; failed: number; removed: number }>(
      socket,
      'POST',
      '/v1/notify',
      {
        text,
        sessionId,
      },
    )
    console.log(`sent ${result.sent}, failed ${result.failed}, removed ${result.removed}`)
    return result.failed > 0 ? 1 : 0
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ECONNREFUSED') {
      console.error(
        `The Bancada server is not running (no control socket at ${socket}). Start it with: pnpm --filter @bancada/server start`,
      )
    } else if (error instanceof ControlError) {
      console.error(`The server refused the request: ${error.code}`)
    } else {
      console.error(error instanceof Error ? error.message : String(error))
    }
    return 1
  }
}
