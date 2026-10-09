import type { HostEvent, SessionInfo } from '@bancada/protocol'
import { type PtyClient, PtyHostError } from '@bancada/pty-host'
import type { HostConnector } from '../host-link.js'

type DataListener = (bytes: Uint8Array) => void

/** A pty-host stand-in for the unit tests: sessions in memory, echo on input, and a record of forbidden calls. */
export class FakeHost {
  readonly sessions: SessionInfo[] = []
  readonly clients: FakePty[] = []
  /** Calls the server must never make on behalf of the phone. */
  readonly forbidden: string[] = []
  readonly screens = new Map<string, string>()
  failConnect = false

  readonly connector: HostConnector = {
    connect: async () => {
      if (this.failConnect) throw new Error('host down')
      const client = new FakePty(this)
      this.clients.push(client)
      return client as unknown as PtyClient
    },
  }

  addSession(partial: Partial<SessionInfo> & { id: string }): SessionInfo {
    const session: SessionInfo = {
      pid: 1234,
      cwd: '/tmp/acme-web',
      command: '/bin/sh',
      args: [],
      cols: 80,
      rows: 24,
      state: 'running',
      createdAt: Date.now(),
      meta: {},
      ...partial,
    }
    this.sessions.push(session)
    this.emit({ type: 'event', event: 'session-added', session })
    return session
  }

  output(id: string, text: string | Uint8Array): void {
    const bytes = typeof text === 'string' ? Buffer.from(text) : text
    for (const client of this.clients) client.attached.get(id)?.(bytes)
  }

  emit(event: HostEvent): void {
    for (const client of this.clients) for (const listener of client.eventListeners) listener(event)
  }

  liveClients(): FakePty[] {
    return this.clients.filter((c) => !c.closed)
  }
}

export class FakePty {
  closed = false
  readonly attached = new Map<string, DataListener>()
  readonly eventListeners = new Set<(event: HostEvent) => void>()
  readonly writes: { id: string; data: string }[] = []
  private readonly closeListeners = new Set<() => void>()

  constructor(private readonly host: FakeHost) {}

  async list(): Promise<SessionInfo[]> {
    return this.host.sessions.map((s) => ({ ...s }))
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async attach(id: string, onData: DataListener, opts?: { scrollback?: number }) {
    const session = this.host.sessions.find((s) => s.id === id)
    if (!session) throw new PtyHostError('not_found', 'no such session')
    this.attached.set(id, onData)
    return {
      id,
      cols: session.cols,
      rows: session.rows,
      data: this.host.screens.get(id) ?? `screen of ${id}`,
      scrollback: opts?.scrollback,
    }
  }

  write(id: string, data: string | Uint8Array): void {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
    this.writes.push({ id, data: text })
    setTimeout(() => this.host.output(id, text), 0)
  }

  async resize(): Promise<void> {
    this.host.forbidden.push('resize')
  }

  async kill(): Promise<void> {
    this.host.forbidden.push('kill')
  }

  async dispose(): Promise<void> {
    this.host.forbidden.push('dispose')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners) listener()
  }
}
