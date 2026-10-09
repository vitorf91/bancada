import type { HostEvent, SessionId, SessionInfo, Snapshot, SpawnSpec } from '@bancada/protocol'
import type { TerminalPortMessage } from '../shared/api.js'

/** The part of `PtyClient` the hub uses. */
export interface HostClient {
  readonly closed: boolean
  spawn(spec: SpawnSpec): Promise<SessionInfo>
  list(): Promise<SessionInfo[]>
  attach(id: SessionId, onData: (bytes: Uint8Array) => void, opts?: { scrollback?: number }): Promise<Snapshot>
  detach(id: SessionId): Promise<void>
  write(id: SessionId, data: string | Uint8Array): void
  resize(id: SessionId, cols: number, rows: number): Promise<void>
  kill(id: SessionId, signal?: NodeJS.Signals): Promise<void>
  onEvent(listener: (event: HostEvent) => void): () => void
  onClose(listener: (error?: Error) => void): () => void
  close(): void
}

/** The sending end of a MessageChannelMain. */
export interface PortLike {
  postMessage(message: unknown): void
  close(): void
}

/** The webContents a view belongs to. */
export interface SenderLike {
  readonly id: number
  isDestroyed(): boolean
  /** Hands `port` (the receiving end) to the page. */
  deliverPort(viewId: string, port: unknown): void
  onDestroyed(listener: () => void): void
}

export interface TerminalHubDeps {
  /** Connects to the pty-host, launching it first when none runs. */
  connect(): Promise<HostClient>
  createChannel(): { sender: PortLike; receiver: unknown }
  /** Session lifecycle events, for every window. */
  broadcast(event: HostEvent): void
}

interface View {
  id: string
  sender: SenderLike
  port: PortLike
  /** The snapshot has been posted: live bytes may follow. */
  ready: boolean
}

interface Entry {
  views: Map<string, View>
  /** The host streams this session to our (single) connection. */
  hostAttached: boolean
  /** Attach and detach for one session run one at a time. */
  tail: Promise<unknown>
}

/** Errors whose `code` the renderer needs (it gets the message only, across IPC). */
export class HubError extends Error {
  override name = 'HubError'
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function hubErrorFrom(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  return new Error(typeof code === 'string' ? `bancada:${code}:${message}` : message)
}

/**
 * Main-process side of the terminals. The host allows ONE attachment per session per connection (a second attach from
 * the same connection replaces the first), so main attaches once and fans the bytes out to one MessagePort per view.
 * A view that joins a session that is already attached restarts the host attachment and every view of the session
 * gets the fresh snapshot: no gap and no duplicate, at the price of a redraw in the views that were already open.
 */
export class TerminalHub {
  private readonly entries = new Map<SessionId, Entry>()
  private readonly viewSession = new Map<string, SessionId>()
  private readonly watchedSenders = new WeakSet<SenderLike>()
  private client: HostClient | null = null
  private connecting: Promise<HostClient> | null = null

  constructor(private readonly deps: TerminalHubDeps) {}

  /** Connects to the host (launching it when needed). Safe to call again; the connection is reused while it lives. */
  ready(): Promise<HostClient> {
    if (this.client && !this.client.closed) return Promise.resolve(this.client)
    this.connecting ??= this.deps
      .connect()
      .then((client) => {
        this.client = client
        client.onEvent((event) => this.onHostEvent(event))
        client.onClose(() => this.onHostClosed(client))
        return client
      })
      .finally(() => {
        this.connecting = null
      })
    return this.connecting
  }

  async spawn(spec: SpawnSpec): Promise<SessionInfo> {
    return (await this.ready()).spawn(spec)
  }

  async list(): Promise<SessionInfo[]> {
    return (await this.ready()).list()
  }

  async kill(id: SessionId, signal?: NodeJS.Signals): Promise<void> {
    await (await this.ready()).kill(id, signal)
  }

  write(id: SessionId, data: string): void {
    if (this.client && !this.client.closed) this.client.write(id, data)
  }

  resize(id: SessionId, cols: number, rows: number): void {
    if (!this.client || this.client.closed) return
    this.client.resize(id, cols, rows).catch(() => {})
  }

  /**
   * Attaches `viewId` to a session. The view's port receives the snapshot first, then the live bytes. Rejects with
   * the host's error (`not_found` for a session that does not exist).
   */
  async attach(sender: SenderLike, id: SessionId, viewId: string, scrollback?: number): Promise<void> {
    if (this.viewSession.has(viewId)) throw new HubError('invalid_request', `View ${viewId} is already attached`)
    this.watchSender(sender)
    // The view is registered before anything async, so a detach that arrives right behind this call (a
    // double-mounted React effect) finds it.
    const entry = this.entries.get(id) ?? this.createEntry(id)
    const { sender: port, receiver } = this.deps.createChannel()
    const view: View = { id: viewId, sender, port, ready: false }
    entry.views.set(viewId, view)
    this.viewSession.set(viewId, id)
    try {
      const client = await this.ready()
      await this.enqueue(entry, () => this.attachView(client, entry, id, view, receiver, scrollback))
    } catch (error) {
      if (entry.views.get(viewId) === view) {
        this.dropView(view)
        port.close()
      }
      if (entry.views.size === 0 && this.entries.get(id) === entry) this.entries.delete(id)
      throw error
    }
  }

  private async attachView(
    client: HostClient,
    entry: Entry,
    id: SessionId,
    view: View,
    receiver: unknown,
    scrollback: number | undefined,
  ): Promise<void> {
    if (entry.views.get(view.id) !== view) return // detached before its turn
    if (entry.hostAttached) {
      // Restart the attachment: the new view needs a snapshot, and a second attach on this connection would
      // replace the first one with a misleading invalid_request.
      entry.hostAttached = false
      await client.detach(id).catch(() => {})
    }
    let snapshot: Snapshot
    try {
      snapshot = await client.attach(id, (bytes) => this.fanOut(entry, bytes), { scrollback })
    } catch (error) {
      // The views that were streaming lost their attachment with the restart: tell them.
      for (const other of [...entry.views.values()]) if (other !== view && other.ready) this.closeView(other, true)
      throw error
    }
    entry.hostAttached = true
    view.ready = true
    const message: TerminalPortMessage = {
      t: 'snapshot',
      cols: snapshot.cols,
      rows: snapshot.rows,
      data: snapshot.data,
    }
    for (const target of entry.views.values()) if (target.ready) target.port.postMessage(message)
    if (entry.views.get(view.id) === view) view.sender.deliverPort(view.id, receiver)
  }

  /** Stops the stream to one view; when it was the last one of its session, the host attachment goes too. */
  detach(viewId: string): Promise<void> {
    const id = this.viewSession.get(viewId)
    const entry = id === undefined ? undefined : this.entries.get(id)
    const view = entry?.views.get(viewId)
    if (!id || !entry || !view) return Promise.resolve()
    this.dropView(view)
    view.port.close()
    return this.releaseIfUnused(id, entry)
  }

  /** The window went away: all its views detach. */
  detachSender(sender: SenderLike): void {
    for (const [id, entry] of this.entries) {
      for (const view of [...entry.views.values()]) {
        if (view.sender !== sender) continue
        this.dropView(view)
        view.port.close()
      }
      void this.releaseIfUnused(id, entry)
    }
  }

  /** Closes the connection to the host. The sessions keep running. */
  dispose(): void {
    const client = this.client
    this.client = null
    for (const entry of this.entries.values()) {
      for (const view of entry.views.values()) view.port.close()
    }
    this.entries.clear()
    this.viewSession.clear()
    client?.close()
  }

  private createEntry(id: SessionId): Entry {
    const entry: Entry = { views: new Map(), hostAttached: false, tail: Promise.resolve() }
    this.entries.set(id, entry)
    return entry
  }

  private enqueue<T>(entry: Entry, job: () => Promise<T>): Promise<T> {
    const run = entry.tail.then(job, job)
    entry.tail = run.catch(() => {})
    return run
  }

  private releaseIfUnused(id: SessionId, entry: Entry): Promise<void> {
    return this.enqueue(entry, async () => {
      if (entry.views.size > 0) return
      if (entry.hostAttached) {
        entry.hostAttached = false
        const client = this.client
        if (client && !client.closed) await client.detach(id).catch(() => {})
      }
      if (entry.views.size === 0 && this.entries.get(id) === entry) this.entries.delete(id)
    })
  }

  private dropView(view: View): void {
    const id = this.viewSession.get(view.id)
    this.viewSession.delete(view.id)
    if (id !== undefined) this.entries.get(id)?.views.delete(view.id)
  }

  private closeView(view: View, notify: boolean): void {
    if (notify) view.port.postMessage({ t: 'closed' } satisfies TerminalPortMessage)
    this.dropView(view)
    view.port.close()
  }

  /** One tight copy of the bytes, posted to every view. A Buffer is a view into a larger socket chunk, and structured clone would ship the whole chunk. */
  private fanOut(entry: Entry, bytes: Uint8Array): void {
    if (entry.views.size === 0) return
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    for (const view of entry.views.values()) if (view.ready) view.port.postMessage(copy)
  }

  private onHostEvent(event: HostEvent): void {
    if (event.event === 'session-exited') {
      const entry = this.entries.get(event.id)
      const message: TerminalPortMessage = { t: 'exit', exitCode: event.exitCode, signal: event.signal }
      for (const view of entry?.views.values() ?? []) view.port.postMessage(message)
    }
    this.deps.broadcast(event)
  }

  private onHostClosed(client: HostClient): void {
    if (this.client !== client) return
    this.client = null
    for (const entry of this.entries.values()) {
      entry.hostAttached = false
      for (const view of [...entry.views.values()]) this.closeView(view, true)
    }
    this.entries.clear()
  }

  private watchSender(sender: SenderLike): void {
    if (this.watchedSenders.has(sender)) return
    this.watchedSenders.add(sender)
    sender.onDestroyed(() => this.detachSender(sender))
  }
}
