import net from 'node:net'
import {
  type ClientRequest,
  FrameKind,
  type HelloResult,
  type HostEvent,
  type HostMessage,
  type ProtocolError,
  PTY_PROTOCOL_VERSION,
  type PtyHostClient,
  type SessionId,
  type SessionInfo,
  type Snapshot,
  type SpawnSpec,
} from '@bancada/protocol'
import { decodeControl, decodeData, encodeControl, encodeData, FrameDecoder } from './frame.js'

export class PtyHostError extends Error {
  override name = 'PtyHostError'
  constructor(
    readonly code: ProtocolError['code'] | 'connection_closed',
    message: string,
  ) {
    super(message)
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface AttachState {
  onData: (bytes: Uint8Array) => void
  /** Output that arrives in the same chunk as the snapshot reply waits here until the caller has the snapshot. */
  held: Uint8Array[] | null
}

export interface ConnectOptions {
  socketPath: string
  /** Name reported in `hello`; shows up nowhere but the host's view of its clients. */
  clientName?: string
  /** Give up connecting after this long. Default 5000 ms. */
  timeoutMs?: number
}

type EventListener = (event: HostEvent) => void
type CloseListener = (error?: Error) => void

/**
 * Pure-JS client of the pty-host (no native dependencies). Never kills the host: on a protocol mismatch it
 * reports an error and closes only its own connection.
 */
export class PtyClient implements PtyHostClient {
  private readonly decoder = new FrameDecoder()
  private readonly pending = new Map<number, Pending>()
  private readonly attached = new Map<SessionId, AttachState>()
  private readonly eventListeners = new Set<EventListener>()
  private readonly closeListeners = new Set<CloseListener>()
  private nextReqId = 1
  private closedWith: { error?: Error } | null = null
  private helloResult: HelloResult | null = null

  private constructor(
    private readonly socket: net.Socket,
    private readonly clientName: string,
  ) {
    socket.on('data', (chunk) => {
      try {
        for (const frame of this.decoder.push(chunk)) this.onFrame(frame)
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => this.fail())
  }

  /** Connects to the socket and performs `hello`. */
  static async connect(options: ConnectOptions): Promise<PtyClient> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(options.socketPath)
      const timer = setTimeout(() => {
        s.destroy()
        reject(new PtyHostError('connection_closed', `Timed out connecting to ${options.socketPath}`))
      }, options.timeoutMs ?? 5000)
      s.once('connect', () => {
        clearTimeout(timer)
        s.removeListener('error', onError)
        resolve(s)
      })
      const onError = (error: Error): void => {
        clearTimeout(timer)
        reject(error)
      }
      s.once('error', onError)
    })
    const client = new PtyClient(socket, options.clientName ?? 'pty-client')
    try {
      await client.hello()
    } catch (error) {
      client.close()
      throw error
    }
    return client
  }

  get closed(): boolean {
    return this.closedWith !== null
  }

  /** Called once when the connection ends (host gone, socket error, or `close()`); `error` is set for failures. */
  onClose(listener: CloseListener): () => void {
    if (this.closedWith) {
      listener(this.closedWith.error)
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async hello(): Promise<HelloResult> {
    const result = await this.request<HelloResult>({
      type: 'hello',
      client: this.clientName,
      protocol: PTY_PROTOCOL_VERSION,
    })
    this.helloResult = result
    return result
  }

  /** What the host said in `hello` (set once connected). */
  get host(): HelloResult | null {
    return this.helloResult
  }

  spawn(spec: SpawnSpec): Promise<SessionInfo> {
    return this.request({ type: 'spawn', spec })
  }

  list(): Promise<SessionInfo[]> {
    return this.request({ type: 'list' })
  }

  /**
   * Resolves with the snapshot. `onData` then receives every byte after the cutoff, in order; it is never called
   * before the caller's continuation has had a turn, so apply the snapshot synchronously after the `await`.
   */
  async attach(id: SessionId, onData: (bytes: Uint8Array) => void, opts?: { scrollback?: number }): Promise<Snapshot> {
    const state: AttachState = { onData, held: [] }
    this.attached.set(id, state)
    try {
      const snapshot = await this.request<Snapshot>({ type: 'attach', id, scrollback: opts?.scrollback })
      setImmediate(() => {
        const held = state.held ?? []
        state.held = null
        for (const bytes of held) onData(bytes)
      })
      return snapshot
    } catch (error) {
      if (this.attached.get(id) === state) this.attached.delete(id)
      throw error
    }
  }

  async detach(id: SessionId): Promise<void> {
    this.attached.delete(id)
    await this.request({ type: 'detach', id })
  }

  write(id: SessionId, data: string | Uint8Array): void {
    if (this.closedWith) return
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    this.socket.write(encodeData(FrameKind.Input, id, bytes))
  }

  async resize(id: SessionId, cols: number, rows: number): Promise<void> {
    await this.request({ type: 'resize', id, cols, rows })
  }

  async kill(id: SessionId, signal?: NodeJS.Signals): Promise<void> {
    await this.request({ type: 'kill', id, signal })
  }

  async dispose(id: SessionId): Promise<void> {
    this.attached.delete(id)
    await this.request({ type: 'dispose', id })
  }

  snapshot(id: SessionId, opts?: { scrollback?: number }): Promise<Snapshot> {
    return this.request({ type: 'snapshot', id, scrollback: opts?.scrollback })
  }

  /** Stops the host. Refused with `sessions_alive` while sessions run, unless `force`. */
  async shutdown(force = false): Promise<void> {
    await this.request({ type: 'shutdown', force })
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  close(): void {
    this.fail()
    this.socket.destroy()
  }

  private request<T>(request: DistributiveOmit<ClientRequest, 'reqId'>): Promise<T> {
    if (this.closedWith) {
      return Promise.reject(new PtyHostError('connection_closed', 'The connection to the pty-host is closed'))
    }
    const reqId = this.nextReqId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve: resolve as (value: unknown) => void, reject })
      this.socket.write(encodeControl({ ...request, reqId } as ClientRequest))
    })
  }

  private onFrame(frame: { kind: number; payload: Buffer }): void {
    if (frame.kind === FrameKind.Output) {
      const { id, data } = decodeData(frame)
      const state = this.attached.get(id)
      if (!state) return
      if (state.held) state.held.push(data)
      else state.onData(data)
      return
    }
    if (frame.kind !== FrameKind.Control) return
    const message = decodeControl<HostMessage>(frame)
    if (message.type === 'reply') {
      const pending = this.pending.get(message.reqId)
      if (!pending) return
      this.pending.delete(message.reqId)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new PtyHostError(message.error.code, message.error.message))
      return
    }
    for (const listener of this.eventListeners) {
      try {
        listener(message)
      } catch {
        // a listener's bug must not break the stream
      }
    }
  }

  private fail(error?: Error): void {
    if (this.closedWith) return
    this.closedWith = { error }
    const reason = error ?? new PtyHostError('connection_closed', 'The connection to the pty-host closed')
    for (const pending of this.pending.values()) pending.reject(reason)
    this.pending.clear()
    this.attached.clear()
    for (const listener of this.closeListeners) {
      try {
        listener(error)
      } catch {
        // ignore
      }
    }
    this.closeListeners.clear()
    if (error) this.socket.destroy()
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
