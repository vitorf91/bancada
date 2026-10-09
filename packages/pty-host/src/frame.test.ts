import { FrameKind } from '@bancada/protocol'
import { describe, expect, it } from 'vitest'
import {
  decodeControl,
  decodeData,
  encodeControl,
  encodeData,
  encodeFrame,
  type Frame,
  FrameDecoder,
  FrameError,
  MAX_FRAME_BYTES,
} from './frame.js'

/** mulberry32: small seeded PRNG, so a failing split is reproducible from the seed in the test name. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sampleFrames(rand: () => number): Buffer[] {
  const frames: Buffer[] = []
  const count = 5 + Math.floor(rand() * 40)
  for (let i = 0; i < count; i++) {
    const pick = rand()
    const data = Buffer.alloc(Math.floor(rand() * (rand() < 0.1 ? 70000 : 300)))
    for (let j = 0; j < data.length; j++) data[j] = Math.floor(rand() * 256)
    if (pick < 0.33) frames.push(encodeControl({ type: 'list', reqId: i }))
    else if (pick < 0.66) frames.push(encodeData(FrameKind.Output, `sess-${i}`, data))
    else frames.push(encodeData(FrameKind.Input, 'x'.repeat(1 + Math.floor(rand() * 64)), data))
  }
  return frames
}

/** Cuts `stream` at random boundaries, including empty chunks and 1-byte chunks. */
function randomChunks(stream: Buffer, rand: () => number): Buffer[] {
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < stream.length) {
    const size = rand() < 0.2 ? Math.floor(rand() * 4) : Math.floor(rand() * 2000)
    chunks.push(stream.subarray(offset, offset + size))
    offset += size
  }
  return chunks
}

function describeFrames(frames: Frame[]): string[] {
  return frames.map((f) => `${f.kind}:${f.payload.toString('hex')}`)
}

describe('encode', () => {
  it('lays out u32be length | u8 kind | payload, length counting kind + payload', () => {
    const out = encodeFrame(FrameKind.Control, Buffer.from('abc'))
    expect([...out]).toEqual([0, 0, 0, 4, 1, 0x61, 0x62, 0x63])
  })

  it('lays out data frames as u8 idLength | id | bytes', () => {
    const out = encodeData(FrameKind.Input, 'ab', Buffer.from([9, 8]))
    expect([...out]).toEqual([0, 0, 0, 6, 3, 2, 0x61, 0x62, 9, 8])
  })

  it('round-trips control messages and data frames', () => {
    const decoder = new FrameDecoder()
    const [control, output] = decoder.push(
      Buffer.concat([encodeControl({ type: 'list', reqId: 7 }), encodeData(FrameKind.Output, 's1', Buffer.from('hi'))]),
    )
    expect(control && decodeControl(control)).toEqual({ type: 'list', reqId: 7 })
    expect(output && decodeData(output)).toEqual({ id: 's1', data: Buffer.from('hi') })
  })

  it('rejects ids that do not fit the u8 length', () => {
    expect(() => encodeData(FrameKind.Output, '', Buffer.alloc(0))).toThrow(FrameError)
    expect(() => encodeData(FrameKind.Output, 'a'.repeat(256), Buffer.alloc(0))).toThrow(FrameError)
  })
})

describe('FrameDecoder', () => {
  it('decodes an empty-payload data frame', () => {
    const decoder = new FrameDecoder()
    const [frame] = decoder.push(encodeData(FrameKind.Output, 'id', Buffer.alloc(0)))
    expect(frame && decodeData(frame)).toEqual({ id: 'id', data: Buffer.alloc(0) })
  })

  it('waits for the rest of a frame split inside the 4-byte header', () => {
    const decoder = new FrameDecoder()
    const bytes = encodeData(FrameKind.Output, 's', Buffer.from('payload'))
    expect(decoder.push(bytes.subarray(0, 1))).toEqual([])
    expect(decoder.push(bytes.subarray(1, 3))).toEqual([])
    expect(decoder.pendingBytes).toBe(3)
    const frames = decoder.push(bytes.subarray(3))
    expect(frames).toHaveLength(1)
    expect(decoder.pendingBytes).toBe(0)
  })

  it('rejects a zero length and an oversized length', () => {
    expect(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 0, 1]))).toThrow(FrameError)
    const huge = Buffer.alloc(5)
    huge.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => new FrameDecoder().push(huge)).toThrow(FrameError)
  })

  it('rejects a malformed data frame', () => {
    const decoder = new FrameDecoder()
    const [frame] = decoder.push(encodeFrame(FrameKind.Output, Buffer.from([5, 0x61])))
    expect(() => frame && decodeData(frame)).toThrow(FrameError)
  })

  for (const seed of Array.from({ length: 200 }, (_, i) => i + 1)) {
    it(`gives the same frames for any chunking (seed ${seed})`, () => {
      const rand = prng(seed)
      const frames = sampleFrames(rand)
      const stream = Buffer.concat(frames)
      const expected = describeFrames(new FrameDecoder().push(stream))
      expect(expected).toHaveLength(frames.length)

      const decoder = new FrameDecoder()
      const got: Frame[] = []
      for (const chunk of randomChunks(stream, rand)) got.push(...decoder.push(chunk))
      expect(describeFrames(got)).toEqual(expected)
      expect(decoder.pendingBytes).toBe(0)
    })
  }

  it('decodes a stream split into single bytes', () => {
    const rand = prng(99)
    const frames = sampleFrames(rand).slice(0, 8)
    const stream = Buffer.concat(frames)
    const decoder = new FrameDecoder()
    const got: Frame[] = []
    for (let i = 0; i < stream.length; i++) got.push(...decoder.push(stream.subarray(i, i + 1)))
    expect(describeFrames(got)).toEqual(describeFrames(new FrameDecoder().push(stream)))
  })
})
