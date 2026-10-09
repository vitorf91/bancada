import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import {
  type ClientRequest,
  FrameKind,
  type HelloResult,
  type HostEvent,
  type HostMessage,
  type ProtocolError,
  PTY_PROTOCOL_VERSION,
  type SpawnSpec,
} from '@bancada/protocol'
import { fallbackSocketDir, resolvePidPath, resolveProfile, resolveSocketPath } from '@bancada/protocol/paths'
import { decodeControl, decodeData, encodeControl, encodeData, FrameDecoder, FrameError } from '../frame.js'
import { buildSessionEnv, commandExists, resolveCommand } from './env.js'
import { acquirePidLock } from './lock.js'
import type { HostLogger } from './log.js'
import { Session } from './session.js'

/** A client that cannot keep up is dropped rather than letting the host buffer without bound. */
const MAX_CLIENT_BACKLOG_BYTES = 64 * 1024 * 1024
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/
const MAX_DIMENSION = 10_000

export interface HostServerOptions {
  dataDir: string
  hostVersion: string
  appVersion: string
  env: Readonly<Record<string, string | undefined>>
  logger: HostLogger
}

class RequestError extends Error {
  constructor(
    readonly code: ProtocolError['code'],
    message: string,
  ) {
    super(message)
  }
}

class Connection {
  helloed = false
  readonly attached = new Set<string>()
  readonly decoder = new FrameDecoder()

  constructor(
    readonly id: number,
    readonly socket: net.Socket,
    private readonly logger: HostLogger,
  ) {}

  private write(bytes: Buffer): void {
    if (this.socket.destroyed) return
    if (this.socket.writableLength > MAX_CLIENT_BACKLOG_BYTES) {
      this.logger.warn('dropping client that stopped reading', { connection: this.id })
      this.socket.destroy()
      return
    }
    this.socket.write(bytes)
  }

  sendMessage(message: HostMessage): void {
    this.write(encodeControl(message))
  }

  sendOutput(sessionId: string, data: Buffer): void {
    this.write(encodeData(FrameKind.Output, sessionId, data))
  }
}

export class HostServer {
  private readonly sessions = new Map<string, Session>()
  private readonly connections = new Set<Connection>()
  private readonly server: net.Server
  private readonly socketPath: string
  private readonly profile: string
  private readonly startedAt = Date.now()
  private releaseLock: (() => void) | null = null
  private nextConnectionId = 1
  private stopped: Promise<void> | null = null
  private resolveClosed!: () => void
  /** Resolves when the host has shut down and cleaned up. */
  readonly closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve
  })

  constructor(private readonly options: HostServerOptions) {
    this.socketPath = resolveSocketPath(options.dataDir, process.getuid?.() ?? 0)
    this.profile = resolveProfile(options.env)
    this.server = net.createServer((socket) => this.onConnection(socket))
  }

  get path(): string {
    return this.socketPath
  }

  /** Takes the pid lock, binds the socket (mode 0600) and starts serving. Throws if another host owns the data dir. */
  async start(): Promise<void> {
    const { dataDir, logger } = this.options
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    this.releaseLock = acquirePidLock(resolvePidPath(dataDir))
    try {
      this.prepareSocketDir()
      // The lock is ours, so any socket file left here belongs to a dead host.
      fs.rmSync(this.socketPath, { force: true })
      // Created under a restrictive umask so the socket is never visible with wider permissions.
      const previousUmask = process.umask(0o177)
      try {
        await new Promise<void>((resolve, reject) => {
          this.server.once('error', reject)
          this.server.listen(this.socketPath, () => {
            this.server.off('error', reject)
            resolve()
          })
        })
      } finally {
        process.umask(previousUmask)
      }
      fs.chmodSync(this.socketPath, 0o600)
    } catch (error) {
      this.releaseLock()
      this.releaseLock = null
      throw error
    }
    this.server.on('error', (error) => logger.error('server error', { error: String(error) }))
    logger.info('pty-host started', {
      pid: process.pid,
      version: this.options.hostVersion,
      protocol: PTY_PROTOCOL_VERSION,
      socket: this.socketPath,
    })
  }

  private prepareSocketDir(): void {
    const uid = process.getuid?.() ?? 0
    const fallbackDir = fallbackSocketDir(uid)
    if (!this.socketPath.startsWith(`${fallbackDir}/`)) return
    fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 })
    const stat = fs.lstatSync(fallbackDir)
    if (!stat.isDirectory() || stat.uid !== uid) throw new Error(`${fallbackDir} is not a directory owned by this user`)
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(fallbackDir, 0o700)
  }

  /** Sessions with a live process. Exited sessions kept for their snapshot do not count. */
  get aliveSessions(): number {
    let alive = 0
    for (const session of this.sessions.values()) if (session.running) alive++
    return alive
  }

  private onConnection(socket: net.Socket): void {
    const connection = new Connection(this.nextConnectionId++, socket, this.options.logger)
    this.connections.add(connection)
    this.options.logger.info('client connected', { connection: connection.id })
    socket.on('data', (chunk) => {
      try {
        for (const frame of connection.decoder.push(chunk)) this.onFrame(connection, frame)
      } catch (error) {
        this.options.logger.warn('closing connection after protocol violation', {
          connection: connection.id,
          error: error instanceof Error ? error.message : String(error),
        })
        socket.destroy()
      }
    })
    socket.on('error', (error) => {
      this.options.logger.info('client socket error', { connection: connection.id, error: String(error) })
    })
    socket.on('close', () => {
      for (const id of connection.attached) this.sessions.get(id)?.detach(connection.id)
      this.connections.delete(connection)
      this.options.logger.info('client disconnected', { connection: connection.id })
    })
  }

  private onFrame(connection: Connection, frame: { kind: number; payload: Buffer }): void {
    switch (frame.kind) {
      case FrameKind.Control:
        this.onControl(connection, decodeControl<ClientRequest>(frame))
        return
      case FrameKind.Input: {
        if (!connection.helloed) return
        const { id, data } = decodeData(frame)
        this.sessions.get(id)?.write(data)
        return
      }
      default:
        throw new FrameError(`Unexpected frame kind ${frame.kind}`)
    }
  }

  private onControl(connection: Connection, request: ClientRequest): void {
    const reqId = request?.reqId
    if (typeof reqId !== 'number') throw new FrameError('Control message without a reqId')
    const ok = (result?: unknown): void => connection.sendMessage({ type: 'reply', reqId, ok: true, result })
    const fail = (error: unknown): void => {
      const known = error instanceof RequestError
      if (!known) this.options.logger.error('request failed', { type: request.type, error: String(error) })
      connection.sendMessage({
        type: 'reply',
        reqId,
        ok: false,
        error: {
          code: known ? error.code : 'internal',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }

    try {
      if (request.type === 'hello') {
        if (request.protocol !== PTY_PROTOCOL_VERSION) {
          throw new RequestError(
            'protocol_mismatch',
            `Host speaks protocol ${PTY_PROTOCOL_VERSION}, client sent ${String(request.protocol)}`,
          )
        }
        connection.helloed = true
        const result: HelloResult = {
          protocol: PTY_PROTOCOL_VERSION,
          hostVersion: this.options.hostVersion,
          pid: process.pid,
          startedAt: this.startedAt,
        }
        ok(result)
        return
      }
      if (!connection.helloed) throw new RequestError('invalid_request', 'hello must be the first request')

      switch (request.type) {
        case 'spawn': {
          const session = this.spawnSession(request.spec)
          ok(session.info)
          this.broadcast({ type: 'event', event: 'session-added', session: session.info })
          return
        }
        case 'list':
          ok([...this.sessions.values()].map((s) => s.info))
          return
        case 'attach': {
          const session = this.requireSession(request.id)
          connection.attached.add(session.id)
          session.attach(
            connection.id,
            (data) => connection.sendOutput(session.id, data),
            optionalCount(request.scrollback, 'scrollback'),
            (snapshot) => ok(snapshot),
            (message) => fail(new RequestError('invalid_request', message)),
          )
          return
        }
        case 'detach':
          this.requireSession(request.id).detach(connection.id)
          connection.attached.delete(request.id)
          ok()
          return
        case 'resize': {
          const session = this.requireSession(request.id)
          session.resize(dimension(request.cols, 'cols'), dimension(request.rows, 'rows'))
          ok()
          return
        }
        case 'kill':
          if (request.signal !== undefined && !/^SIG[A-Z0-9]{2,12}$/.test(String(request.signal))) {
            throw new RequestError('invalid_request', `Invalid signal ${String(request.signal)}`)
          }
          this.requireSession(request.id).kill(request.signal)
          ok()
          return
        case 'dispose': {
          const session = this.requireSession(request.id)
          this.sessions.delete(session.id)
          session.dispose()
          this.options.logger.info('session disposed', { id: session.id })
          ok()
          this.broadcast({ type: 'event', event: 'session-removed', id: session.id })
          return
        }
        case 'snapshot':
          this.requireSession(request.id).snapshot(optionalCount(request.scrollback, 'scrollback')).then(ok, fail)
          return
        case 'shutdown': {
          const alive = this.aliveSessions
          if (alive > 0 && !request.force) {
            throw new RequestError(
              'sessions_alive',
              `${alive} session(s) still running; shut down with force to kill them`,
            )
          }
          ok()
          void this.shutdown('shutdown request')
          return
        }
        default:
          throw new RequestError(
            'invalid_request',
            `Unknown request type ${String((request as { type: unknown }).type)}`,
          )
      }
    } catch (error) {
      fail(error)
    }
  }

  private requireSession(id: unknown): Session {
    const session = typeof id === 'string' ? this.sessions.get(id) : undefined
    if (!session) throw new RequestError('not_found', `No session ${String(id)}`)
    return session
  }

  private spawnSession(spec: SpawnSpec): Session {
    if (!spec || typeof spec !== 'object') throw new RequestError('invalid_request', 'spawn needs a spec')
    const id = spec.id ?? randomUUID()
    if (!SESSION_ID_PATTERN.test(id)) {
      throw new RequestError(
        'invalid_request',
        'Session id must be 1-64 chars of letters, digits, ".", "_", ":" or "-"',
      )
    }
    if (this.sessions.has(id)) throw new RequestError('invalid_request', `Session ${id} already exists`)
    const cols = dimension(spec.cols, 'cols')
    const rows = dimension(spec.rows, 'rows')
    if (typeof spec.cwd !== 'string' || !fs.statSync(spec.cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new RequestError('spawn_failed', `cwd is not a directory: ${String(spec.cwd)}`)
    }
    const { command, args } = resolveCommand(spec, this.options.env)
    const env = buildSessionEnv({
      hostEnv: this.options.env,
      sessionId: id,
      profile: this.profile,
      appVersion: this.options.appVersion,
      specEnv: spec.env,
    })
    // node-pty forks first and reports a missing binary as an instant exit, so check up front.
    if (!commandExists(command, spec.cwd, env.PATH)) {
      throw new RequestError('spawn_failed', `Command not found or not executable: ${command}`)
    }
    try {
      const session = new Session({
        id,
        cwd: spec.cwd,
        command,
        args,
        env,
        cols,
        rows,
        meta: { ...spec.meta },
        logger: this.options.logger,
        onExit: (s) =>
          this.broadcast({
            type: 'event',
            event: 'session-exited',
            id: s.id,
            exitCode: s.info.exitCode ?? null,
            signal: s.info.signal ?? null,
          }),
        onTitle: (s, title) => this.broadcast({ type: 'event', event: 'session-title', id: s.id, title }),
      })
      this.sessions.set(id, session)
      return session
    } catch (error) {
      this.options.logger.warn('spawn failed', { id, error: String(error) })
      throw new RequestError('spawn_failed', error instanceof Error ? error.message : String(error))
    }
  }

  private broadcast(event: HostEvent): void {
    for (const connection of this.connections) if (connection.helloed) connection.sendMessage(event)
  }

  /** Kills every session, closes the socket, removes the socket and pid files. Idempotent. */
  shutdown(reason: string): Promise<void> {
    if (this.stopped) return this.stopped
    this.stopped = (async () => {
      this.options.logger.info('shutting down', { reason, sessions: this.sessions.size, alive: this.aliveSessions })
      this.server.close()
      const pids = [...this.sessions.values()].flatMap((s) => (s.info.pid !== null && s.running ? [s.info.pid] : []))
      for (const session of this.sessions.values()) session.dispose()
      this.sessions.clear()
      await killSurvivors(pids)
      // Let the shutdown reply reach the client before its socket goes away.
      await new Promise((resolve) => setTimeout(resolve, 50))
      for (const connection of this.connections) connection.socket.destroy()
      fs.rmSync(this.socketPath, { force: true })
      this.releaseLock?.()
      this.releaseLock = null
      this.options.logger.info('pty-host stopped')
      this.resolveClosed()
    })()
    return this.stopped
  }
}

function dimension(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
    throw new RequestError('invalid_request', `${name} must be an integer between 1 and ${MAX_DIMENSION}`)
  }
  return value
}

function optionalCount(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RequestError('invalid_request', `${name} must be a non-negative integer`)
  }
  return value
}

/** After SIGHUP, give processes a moment to leave, then SIGKILL whoever ignored it: the host is about to exit. */
async function killSurvivors(pids: number[], graceMs = 1000): Promise<void> {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const deadline = Date.now() + graceMs
  while (pids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  for (const pid of pids.filter(alive)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // gone in the meantime
    }
  }
}
