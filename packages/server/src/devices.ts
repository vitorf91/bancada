import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readJson, writeJsonPrivate } from './fsutil.js'

export interface DeviceInfo {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
}

interface DeviceRecord extends DeviceInfo {
  /** sha256 of the token, hex. The token itself is never stored. */
  tokenHash: string
}

interface DevicesFile {
  version: 1
  devices: DeviceRecord[]
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function sanitizeDeviceName(raw: unknown): string {
  const printable =
    typeof raw === 'string' ? [...raw].filter((c) => (c.codePointAt(0) ?? 0) >= 0x20 && c !== '\x7f').join('') : ''
  return printable.trim().slice(0, 60) || 'Aparelho'
}

type RevokeListener = (device: DeviceInfo) => void

/** Paired devices: `<dataDir>/devices.json` (mode 0600) holds the sha256 of each token, a name and two timestamps. */
export class DeviceStore {
  private readonly byHash = new Map<string, DeviceRecord>()
  private readonly revokeListeners = new Set<RevokeListener>()
  private lastWrite = 0
  private dirty = false
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    const data = readJson<Partial<DevicesFile>>(file, {})
    for (const record of data.devices ?? []) {
      if (record && typeof record.tokenHash === 'string' && typeof record.id === 'string') {
        this.byHash.set(record.tokenHash, record)
      }
    }
  }

  /** Creates a device and returns its token. This is the only time the token exists in the clear. */
  create(name: unknown): { device: DeviceInfo; token: string } {
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    const record: DeviceRecord = {
      id: randomUUID(),
      name: sanitizeDeviceName(name),
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: now,
    }
    this.byHash.set(record.tokenHash, record)
    this.save()
    return { device: toInfo(record), token }
  }

  /** The device a token belongs to, or null. Updates `lastSeenAt` (persisted at most once a minute). */
  authenticate(token: string | undefined): DeviceInfo | null {
    if (!token || !TOKEN_RE.test(token)) return null
    const record = this.byHash.get(hashToken(token))
    if (!record) return null
    const now = this.now()
    record.lastSeenAt = now
    this.dirty = true
    if (now - this.lastWrite >= LAST_SEEN_WRITE_INTERVAL_MS) this.save()
    else this.scheduleSave()
    return toInfo(record)
  }

  list(): DeviceInfo[] {
    return [...this.byHash.values()].map(toInfo).sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Removes a device right away and tells the listeners (which close its sockets and drop its subscriptions). */
  revoke(id: string): boolean {
    for (const [hash, record] of this.byHash) {
      if (record.id !== id) continue
      this.byHash.delete(hash)
      this.save()
      for (const listener of this.revokeListeners) listener(toInfo(record))
      return true
    }
    return false
  }

  /** Resolves a full id or a unique prefix (what the CLI shows). */
  resolveId(idOrPrefix: string): string | null {
    const matches = this.list().filter(
      (d) => d.id === idOrPrefix || (idOrPrefix.length >= 4 && d.id.startsWith(idOrPrefix)),
    )
    return matches.length === 1 ? (matches[0]?.id ?? null) : null
  }

  onRevoked(listener: RevokeListener): () => void {
    this.revokeListeners.add(listener)
    return () => this.revokeListeners.delete(listener)
  }

  /** Flushes a pending `lastSeenAt` write. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.dirty) this.save()
  }

  private scheduleSave(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.save()
    }, LAST_SEEN_WRITE_INTERVAL_MS)
    this.timer.unref()
  }

  private save(): void {
    this.lastWrite = this.now()
    this.dirty = false
    const data: DevicesFile = { version: 1, devices: [...this.byHash.values()] }
    writeJsonPrivate(this.file, data)
  }
}

function toInfo(record: DeviceRecord): DeviceInfo {
  return { id: record.id, name: record.name, createdAt: record.createdAt, lastSeenAt: record.lastSeenAt }
}
