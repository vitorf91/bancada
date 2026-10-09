import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PtyClient } from '@bancada/pty-host'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')

function selfSignedCert(): { key: string; cert: string } {
  const dir = fs.mkdtempSync(path.join('/tmp', 'bancada-cert-'))
  try {
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${dir}/k.pem`], {
      stdio: 'pipe',
    })
    execFileSync(
      'openssl',
      ['req', '-new', '-x509', '-key', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '2', '-subj', '/CN=localhost'],
      {
        stdio: 'pipe',
      },
    )
    return { key: fs.readFileSync(`${dir}/k.pem`, 'utf8'), cert: fs.readFileSync(`${dir}/c.pem`, 'utf8') }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export interface E2eStack {
  dataDir: string
  workDir: string
  port: number
  proxyPort: number
  client: PtyClient
  socketPath: string
  stop(): Promise<void>
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** One-shot request to the server's control socket. */
export function control<T>(socketPath: string, method: string, requestPath: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: requestPath }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Stands in for `tailscale serve`: HTTPS in front, plain HTTP to 127.0.0.1, with the X-Forwarded-* headers. */
function startTlsProxy(listenPort: number, targetPort: number): Promise<https.Server> {
  const server = https.createServer(selfSignedCert(), (req, res) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host ?? '' },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', () => res.writeHead(502).end())
    req.pipe(upstream)
  })
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
      raw += `x-forwarded-proto: https\r\nx-forwarded-host: ${req.headers.host ?? ''}\r\n\r\n`
      upstream.write(raw)
      upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  return new Promise((resolve) => server.listen(listenPort, '127.0.0.1', () => resolve(server)))
}

export async function startStack(port: number): Promise<E2eStack> {
  const dataDir = fs.mkdtempSync(path.join('/tmp', 'bancada-t-e2e-'))
  const workDir = path.join(dataDir, 'work')
  fs.mkdirSync(workDir)
  const log = fs.openSync(path.join(dataDir, 'server.out'), 'w')
  const env = {
    ...process.env,
    BANCADA_DATA_DIR: dataDir,
    BANCADA_SERVER_PORT: String(port),
    BANCADA_VAPID_FILE: path.join(dataDir, 'vapid.key'),
    BANCADA_PWA_DIR: path.join(repo, 'apps/mobile/dist'),
  }
  const server: ChildProcess = spawn(
    process.execPath,
    [path.join(repo, 'packages/server/scripts/launch.mjs'), 'start'],
    {
      env,
      stdio: ['ignore', log, log],
    },
  )
  const socketPath = path.join(dataDir, 'server.sock')
  const deadline = Date.now() + 40_000
  for (;;) {
    try {
      const status = await control<{ hostConnected: boolean }>(socketPath, 'GET', '/v1/status')
      if (status.hostConnected) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline)
      throw new Error(`The server did not start: ${fs.readFileSync(path.join(dataDir, 'server.out'), 'utf8')}`)
    await wait(200)
  }
  const proxy = await startTlsProxy(port + 1, port)
  const clientBundle = path.join(dataDir, 'bundle', 'host-client.mjs')
  await build({
    entryPoints: [path.join(here, 'host-client.entry.ts')],
    outfile: clientBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning',
  })
  const { connectToHost } = (await import(clientBundle)) as { connectToHost(dataDir: string): Promise<PtyClient> }
  const client = await connectToHost(dataDir)

  return {
    dataDir,
    workDir,
    port,
    proxyPort: port + 1,
    client,
    socketPath,
    async stop() {
      client.close()
      proxy.closeAllConnections()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      server.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          server.kill('SIGKILL')
          resolve()
        }, 5000)
        server.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
      try {
        const pid = Number.parseInt(fs.readFileSync(path.join(dataDir, 'pty-host.pid'), 'utf8'), 10)
        process.kill(pid, 'SIGKILL')
      } catch {
        // host already gone
      }
      await wait(300)
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
