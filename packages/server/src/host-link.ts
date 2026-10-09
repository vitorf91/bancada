import type { SessionInfo } from '@bancada/protocol'
import type { PtyClient } from '@bancada/pty-host'

/** Opens a new connection to the pty-host (launching the host first when none is running). */
export interface HostConnector {
  connect(clientName: string): Promise<PtyClient>
}

export interface HostLinkHooks {
  /** Raw output of any running session, as it arrives (the BEL watcher listens here). */
  onOutput(sessionId: string, bytes: Uint8Array): void
  onSessionGone(sessionId: string): void
  log(message: string): void
}

/**
 * The server's long-lived "monitor" connection to the pty-host: lists sessions, follows their lifecycle and attaches
 * to every running one (scrollback 0) so a BEL is seen even when no phone is watching. Reconnects with backoff when
 * the host goes away. Each phone viewer gets its own connection (`connectViewer`), because a connection holds one
 * attach callback per session and the attach cutoff is what guarantees no gap and no duplicate between snapshot
 * and stream.
 */
export class HostLink {
  private monitor: PtyClient | null = null
  private readonly sessions = new Map<string, SessionInfo>()
  private reconnectTimer: NodeJS.Timeout | null = null
  private backoffMs = 1000
  private stopped = false

  constructor(
    private readonly connector: HostConnector,
    private readonly hooks: HostLinkHooks,
  ) {}

  get connected(): boolean {
    return this.monitor !== null && !this.monitor.closed
  }

  /** Connects once; rejects when the host cannot be reached. Afterwards it reconnects on its own. */
  async start(): Promise<void> {
    await this.connectMonitor()
  }

  close(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.monitor?.close()
    this.monitor = null
  }

  async list(): Promise<SessionInfo[]> {
    const monitor = this.requireMonitor()
    const sessions = await monitor.list()
    this.sessions.clear()
    for (const session of sessions) this.sessions.set(session.id, session)
    return sessions
  }

  /** The session from the last list or event, or a fresh lookup. */
  async find(id: string): Promise<SessionInfo | undefined> {
    const cached = this.sessions.get(id)
    if (cached) return cached
    return (await this.list()).find((s) => s.id === id)
  }

  cached(id: string): SessionInfo | undefined {
    return this.sessions.get(id)
  }

  connectViewer(): Promise<PtyClient> {
    return this.connector.connect('bancada-server-viewer')
  }

  private requireMonitor(): PtyClient {
    if (!this.monitor || this.monitor.closed) throw new HostUnavailableError()
    return this.monitor
  }

  private async connectMonitor(): Promise<void> {
    const client = await this.connector.connect('bancada-server')
    this.monitor = client
    this.backoffMs = 1000
    client.onClose(() => {
      if (this.monitor === client) this.monitor = null
      if (this.stopped) return
      this.hooks.log('pty-host connection closed; reconnecting')
      this.scheduleReconnect()
    })
    client.onEvent((event) => {
      if (event.event === 'session-added') {
        this.sessions.set(event.session.id, event.session)
        this.watch(client, event.session)
      } else if (event.event === 'session-title') {
        const session = this.sessions.get(event.id)
        if (session) session.title = event.title
      } else if (event.event === 'session-exited') {
        const session = this.sessions.get(event.id)
        if (session) {
          session.state = 'exited'
          session.exitCode = event.exitCode
        }
        this.hooks.onSessionGone(event.id)
      } else if (event.event === 'session-removed') {
        this.sessions.delete(event.id)
        this.hooks.onSessionGone(event.id)
      }
    })
    const sessions = await client.list()
    this.sessions.clear()
    for (const session of sessions) {
      this.sessions.set(session.id, session)
      this.watch(client, session)
    }
  }

  private watch(client: PtyClient, session: SessionInfo): void {
    if (session.state !== 'running') return
    client
      .attach(session.id, (bytes) => this.hooks.onOutput(session.id, bytes), { scrollback: 0 })
      .catch((error: unknown) => this.hooks.log(`could not watch a session (${String(error)})`))
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectMonitor().catch((error: unknown) => {
        this.hooks.log(`pty-host reconnect failed (${String(error)})`)
        this.backoffMs = Math.min(this.backoffMs * 2, 15_000)
        this.scheduleReconnect()
      })
    }, this.backoffMs)
    this.reconnectTimer.unref()
  }
}

export class HostUnavailableError extends Error {
  override name = 'HostUnavailableError'
  constructor() {
    super('The pty-host is not reachable')
  }
}
