import { type ClientRequest, FrameKind, type HostMessage } from '@bancada/protocol'

/**
 * pty-host wire framing: `u32be length | u8 kind | payload`, where `length` counts `kind + payload`
 * (docs/ARCHITECTURE.md, "pty-host protocol v1").
 */

const HEADER_BYTES = 4
/** A frame larger than this is a protocol violation (or a corrupted stream), not a big paste. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024
export const MAX_ID_BYTES = 255

export interface Frame {
  kind: number
  payload: Buffer
}

export class FrameError extends Error {
  override name = 'FrameError'
}

export function encodeFrame(kind: FrameKind, ...parts: Uint8Array[]): Buffer {
  let payloadBytes = 0
  for (const part of parts) payloadBytes += part.byteLength
  const length = 1 + payloadBytes
  if (length > MAX_FRAME_BYTES) throw new FrameError(`Frame of ${length} bytes exceeds ${MAX_FRAME_BYTES}`)
  const out = Buffer.allocUnsafe(HEADER_BYTES + length)
  out.writeUInt32BE(length, 0)
  out.writeUInt8(kind, HEADER_BYTES)
  let offset = HEADER_BYTES + 1
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

export function encodeControl(message: ClientRequest | HostMessage): Buffer {
  return encodeFrame(FrameKind.Control, Buffer.from(JSON.stringify(message), 'utf8'))
}

function idHeader(id: string): Buffer {
  const idBytes = Buffer.from(id, 'ascii')
  if (idBytes.length === 0 || idBytes.length > MAX_ID_BYTES)
    throw new FrameError(`Invalid session id length ${idBytes.length}`)
  return Buffer.concat([Buffer.of(idBytes.length), idBytes])
}

/** `u8 idLength | id | data`, used by both Output (host → client) and Input (client → host). */
export function encodeData(kind: FrameKind.Output | FrameKind.Input, id: string, data: Uint8Array): Buffer {
  return encodeFrame(kind, idHeader(id), data)
}

export function decodeControl<T = ClientRequest | HostMessage>(frame: Frame): T {
  return JSON.parse(frame.payload.toString('utf8')) as T
}

export function decodeData(frame: Frame): { id: string; data: Buffer } {
  const idLength = frame.payload[0]
  if (idLength === undefined || idLength === 0 || frame.payload.length < 1 + idLength) {
    throw new FrameError('Malformed data frame')
  }
  return {
    id: frame.payload.toString('ascii', 1, 1 + idLength),
    data: frame.payload.subarray(1 + idLength),
  }
}

/**
 * Streaming decoder: feed it socket chunks of any size and alignment, get whole frames out.
 * Chunks are kept in a list, so a large frame split into many chunks is copied once, not once per chunk.
 */
export class FrameDecoder {
  private chunks: Buffer[] = []
  private buffered = 0

  push(chunk: Uint8Array): Frame[] {
    if (chunk.byteLength > 0) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      this.buffered += chunk.byteLength
    }
    const frames: Frame[] = []
    for (;;) {
      if (this.buffered < HEADER_BYTES) break
      const length = this.peekLength()
      if (length < 1 || length > MAX_FRAME_BYTES) throw new FrameError(`Invalid frame length ${length}`)
      if (this.buffered < HEADER_BYTES + length) break
      const body = this.take(HEADER_BYTES + length)
      frames.push({ kind: body.readUInt8(HEADER_BYTES), payload: body.subarray(HEADER_BYTES + 1) })
    }
    return frames
  }

  /** Bytes received but not yet part of a whole frame. */
  get pendingBytes(): number {
    return this.buffered
  }

  private peekLength(): number {
    const first = this.chunks[0]
    if (first && first.length >= HEADER_BYTES) return first.readUInt32BE(0)
    const head = Buffer.allocUnsafe(HEADER_BYTES)
    let filled = 0
    for (const chunk of this.chunks) {
      const n = Math.min(chunk.length, HEADER_BYTES - filled)
      chunk.copy(head, filled, 0, n)
      filled += n
      if (filled === HEADER_BYTES) break
    }
    return head.readUInt32BE(0)
  }

  /** Removes and returns exactly `bytes` bytes from the front of the buffered stream. */
  private take(bytes: number): Buffer {
    const first = this.chunks[0]
    if (first && first.length >= bytes) {
      const out = first.subarray(0, bytes)
      if (first.length === bytes) this.chunks.shift()
      else this.chunks[0] = first.subarray(bytes)
      this.buffered -= bytes
      return out
    }
    const out = Buffer.allocUnsafe(bytes)
    let filled = 0
    while (filled < bytes) {
      const chunk = this.chunks[0]
      if (!chunk) throw new FrameError('Frame decoder underflow')
      const n = Math.min(chunk.length, bytes - filled)
      chunk.copy(out, filled, 0, n)
      filled += n
      if (n === chunk.length) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(n)
    }
    this.buffered -= bytes
    return out
  }
}
