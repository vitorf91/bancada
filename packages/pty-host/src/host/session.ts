import type { SessionInfo, Snapshot } from '@bancada/protocol'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import * as nodePty from 'node-pty'
import { OutputCoalescer } from './coalescer.js'
import type { HostLogger } from './log.js'

export const SCROLLBACK_LINES = 10_000
/** Parsed-but-not-yet-acknowledged bytes after which the pty is paused (xterm discards past 50 MB of backlog). */
const PARSE_HIGH_WATER = 4 * 1024 * 1024
const PARSE_LOW_WATER = 1024 * 1024
const KILL_GRACE_MS = 3000

/** One attached connection. While `buffer` is an array the client is waiting for its snapshot. */
interface Attachment {
  send: (data: Buffer) => void
  buffer: Buffer[] | null
}

export interface SessionOptions {
  id: string
  cwd: string
  command: string
  args: string[]
  env: Record<string, string>
  cols: number
  rows: number
  meta: Record<string, string>
  logger: HostLogger
  onExit: (session: Session) => void
  onTitle: (session: Session, title: string) => void
}

export class Session {
  readonly info: SessionInfo
  private readonly pty: nodePty.IPty
  private readonly headless: Terminal
  private readonly serializer: SerializeAddon
  private readonly coalescer: OutputCoalescer
  private readonly attachments = new Map<number, Attachment>()
  private parsePending = 0
  private ptyPaused = false
  private disposed = false
  private killTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: SessionOptions) {
    const { id, cwd, command, args, env, cols, rows, meta, logger } = options
    this.headless = new Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true })
    this.serializer = new SerializeAddon()
    this.headless.loadAddon(this.serializer)
    this.headless.onTitleChange((title) => {
      if (this.disposed || title === this.info.title) return
      this.info.title = title
      options.onTitle(this, title)
    })
    this.coalescer = new OutputCoalescer((data) => {
      for (const attachment of this.attachments.values()) {
        if (attachment.buffer === null) attachment.send(data)
      }
    })

    // encoding: null hands us raw Buffers, so a multibyte character is never split by a decoder.
    this.pty = nodePty.spawn(command, args, {
      name: env.TERM ?? 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      encoding: null,
    })
    this.info = {
      id,
      pid: this.pty.pid,
      cwd,
      command,
      args,
      cols,
      rows,
      state: 'running',
      createdAt: Date.now(),
      meta,
    }
    this.pty.onData((data) => this.onPtyData(data as unknown as Buffer))
    this.pty.onExit(({ exitCode, signal }) => this.onPtyExit(exitCode, signal || null))
    logger.info('session spawned', { id, pid: this.pty.pid, cols, rows })
  }

  get id(): string {
    return this.info.id
  }

  get running(): boolean {
    return this.info.state === 'running'
  }

  private onPtyData(chunk: Buffer): void {
    if (this.disposed) return
    this.info.lastOutputAt = Date.now()
    this.parsePending += chunk.length
    this.headless.write(chunk, () => {
      this.parsePending -= chunk.length
      if (this.ptyPaused && this.parsePending < PARSE_LOW_WATER && this.running) {
        this.ptyPaused = false
        this.pty.resume()
      }
    })
    if (!this.ptyPaused && this.parsePending > PARSE_HIGH_WATER && this.running) {
      this.ptyPaused = true
      this.pty.pause()
    }
    for (const attachment of this.attachments.values()) attachment.buffer?.push(chunk)
    this.coalescer.push(chunk)
  }

  private onPtyExit(exitCode: number, signal: number | null): void {
    if (this.killTimer) clearTimeout(this.killTimer)
    this.killTimer = null
    if (this.disposed) return
    this.coalescer.flush()
    this.info.state = 'exited'
    this.info.exitedAt = Date.now()
    this.info.exitCode = exitCode
    this.info.signal = signal || null
    this.info.pid = null
    this.options.logger.info('session exited', { id: this.id, exitCode, signal })
    this.options.onExit(this)
  }

  /**
   * Attach with a cutoff: output that was parsed before this call is in the snapshot, output after it is
   * buffered for this client and sent right behind the snapshot. `reply` runs synchronously inside the
   * headless write callback, so the snapshot always precedes the buffered bytes on the wire.
   */
  attach(
    owner: number,
    send: (data: Buffer) => void,
    scrollback: number | undefined,
    reply: (snapshot: Snapshot) => void,
    fail: (message: string) => void,
  ): void {
    const attachment: Attachment = { send, buffer: [] }
    this.attachments.set(owner, attachment)
    this.headless.write('', () => {
      if (this.attachments.get(owner) !== attachment) {
        fail('detached before the snapshot was taken')
        return
      }
      try {
        // Pending coalesced output is all pre-cutoff or already in this client's buffer: deliver it to the
        // clients that are streaming (this one is still buffering, so it is skipped).
        this.coalescer.flush()
        reply(this.takeSnapshot(scrollback))
        const buffered = attachment.buffer ?? []
        attachment.buffer = null
        if (buffered.length > 0) send(buffered.length === 1 ? (buffered[0] as Buffer) : Buffer.concat(buffered))
      } catch (error) {
        this.attachments.delete(owner)
        fail(error instanceof Error ? error.message : String(error))
      }
    })
  }

  detach(owner: number): void {
    this.attachments.delete(owner)
  }

  /** A snapshot that reflects every byte received before the call. */
  snapshot(scrollback: number | undefined): Promise<Snapshot> {
    return new Promise((resolve, reject) => {
      this.headless.write('', () => {
        try {
          resolve(this.takeSnapshot(scrollback))
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  private takeSnapshot(scrollback: number | undefined): Snapshot {
    const started = performance.now()
    const data = this.serializer.serialize(scrollback === undefined ? undefined : { scrollback })
    this.options.logger.info('snapshot', {
      id: this.id,
      serialize_ms: Number((performance.now() - started).toFixed(3)),
      snapshot_bytes: Buffer.byteLength(data),
      cols: this.headless.cols,
      rows: this.headless.rows,
    })
    return { id: this.id, cols: this.headless.cols, rows: this.headless.rows, data }
  }

  write(data: Uint8Array): void {
    if (!this.running || this.disposed) return
    this.pty.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  }

  /** Last one wins. The mirror resizes behind the output already received, so each byte is parsed at the size it was written for. */
  resize(cols: number, rows: number): void {
    if (this.disposed) return
    this.info.cols = cols
    this.info.rows = rows
    if (this.running) this.pty.resize(cols, rows)
    this.headless.write('', () => {
      if (!this.disposed) this.headless.resize(cols, rows)
    })
  }

  kill(signal: NodeJS.Signals = 'SIGHUP'): void {
    if (!this.running) return
    try {
      this.pty.kill(signal)
    } catch (error) {
      this.options.logger.warn('kill failed', { id: this.id, signal, error: String(error) })
    }
  }

  /** Stops the process (SIGHUP, then SIGKILL after a grace period) and frees the mirror. */
  dispose(): void {
    if (this.disposed) return
    const pid = this.info.pid
    const wasRunning = this.running
    this.disposed = true
    this.attachments.clear()
    this.coalescer.dispose()
    if (wasRunning) {
      try {
        this.pty.kill('SIGHUP')
      } catch {
        // already gone
      }
      if (pid !== null) {
        this.killTimer = setTimeout(() => {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // already gone
          }
        }, KILL_GRACE_MS)
        this.killTimer.unref()
      }
    }
    this.headless.dispose()
  }
}
