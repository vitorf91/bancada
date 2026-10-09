import type { HostEvent, SessionInfo, Snapshot } from '@bancada/protocol'
import { describe, expect, it } from 'vitest'
import { type HostClient, type PortLike, type SenderLike, TerminalHub } from './terminal-hub.js'

class FakePort implements PortLike {
  messages: unknown[] = []
  closed = false
  postMessage(message: unknown): void {
    if (!this.closed) this.messages.push(message)
  }
  close(): void {
    this.closed = true
  }
}

class FakeClient implements HostClient {
  closed = false
  attachCalls = 0
  detachCalls = 0
  private onData: ((bytes: Uint8Array) => void) | null = null
  private events: Array<(event: HostEvent) => void> = []
  private closers: Array<() => void> = []
  screen = 'SCREEN'
  async spawn(): Promise<SessionInfo> {
    throw new Error('unused')
  }
  async list(): Promise<SessionInfo[]> {
    return []
  }
  async attach(id: string, onData: (bytes: Uint8Array) => void): Promise<Snapshot> {
    if (id === 'gone') throw Object.assign(new Error('Session gone not found'), { code: 'not_found' })
    // The real host replaces the attachment of the same connection and fails the first request: model that.
    if (this.onData)
      throw Object.assign(new Error('detached before the snapshot was taken'), { code: 'invalid_request' })
    this.attachCalls++
    this.onData = onData
    return { id, cols: 80, rows: 24, data: this.screen }
  }
  async detach(): Promise<void> {
    this.detachCalls++
    this.onData = null
  }
  write(): void {}
  async resize(): Promise<void> {}
  async kill(): Promise<void> {}
  onEvent(listener: (event: HostEvent) => void): () => void {
    this.events.push(listener)
    return () => {}
  }
  onClose(listener: () => void): () => void {
    this.closers.push(listener)
    return () => {}
  }
  close(): void {
    this.closed = true
  }
  emit(bytes: Uint8Array): void {
    this.onData?.(bytes)
  }
  emitEvent(event: HostEvent): void {
    for (const listener of this.events) listener(event)
  }
  drop(): void {
    this.closed = true
    for (const listener of this.closers) listener()
  }
}

function setup() {
  const client = new FakeClient()
  const ports: FakePort[] = []
  const broadcast: HostEvent[] = []
  const hub = new TerminalHub({
    connect: async () => client,
    createChannel: () => {
      const port = new FakePort()
      ports.push(port)
      return { sender: port, receiver: port }
    },
    broadcast: (event) => broadcast.push(event),
  })
  const delivered = new Map<string, unknown>()
  const destroyed: Array<() => void> = []
  const sender: SenderLike = {
    id: 1,
    isDestroyed: () => false,
    deliverPort: (viewId, port) => delivered.set(viewId, port),
    onDestroyed: (listener) => destroyed.push(listener),
  }
  return { client, hub, ports, broadcast, sender, delivered, destroyed }
}

describe('TerminalHub', () => {
  it('attaches once, sends the snapshot first and then tight copies of the live bytes', async () => {
    const { hub, client, ports, sender, delivered } = setup()
    await hub.attach(sender, 's1', 'v1', 2000)
    expect(delivered.get('v1')).toBe(ports[0])
    // A view into a larger buffer, like a slice of a socket chunk.
    const chunk = new Uint8Array(1024)
    chunk.set([104, 105], 100)
    client.emit(chunk.subarray(100, 102))
    expect(ports[0]?.messages[0]).toEqual({ t: 'snapshot', cols: 80, rows: 24, data: 'SCREEN' })
    const sent = ports[0]?.messages[1] as Uint8Array
    expect([...sent]).toEqual([104, 105])
    expect(sent.buffer.byteLength).toBe(2)
  })

  it('serves a second view of the same session without a second concurrent attach, and resyncs both', async () => {
    const { hub, client, ports, sender } = setup()
    await hub.attach(sender, 's1', 'v1')
    client.emit(new Uint8Array([1]))
    await hub.attach(sender, 's1', 'v2')
    expect(client.attachCalls).toBe(2)
    expect(client.detachCalls).toBe(1)
    client.emit(new Uint8Array([2]))
    const [first, second] = ports
    expect(first?.messages.map((m) => (m instanceof Uint8Array ? [...m] : (m as { t: string }).t))).toEqual([
      'snapshot',
      [1],
      'snapshot',
      [2],
    ])
    expect(second?.messages.map((m) => (m instanceof Uint8Array ? [...m] : (m as { t: string }).t))).toEqual([
      'snapshot',
      [2],
    ])
  })

  it('survives the attach, detach, attach sequence of a double-mounted view', async () => {
    const { hub, client, ports, sender } = setup()
    const first = hub.attach(sender, 's1', 'v1')
    const detach = hub.detach('v1')
    const second = hub.attach(sender, 's1', 'v2')
    await Promise.all([first, detach, second])
    client.emit(new Uint8Array([7]))
    expect(ports[0]?.closed).toBe(true)
    expect((ports[1]?.messages[1] as Uint8Array | undefined)?.[0]).toBe(7)
  })

  it('detaches from the host when the last view goes', async () => {
    const { hub, client, sender } = setup()
    await hub.attach(sender, 's1', 'v1')
    await hub.attach(sender, 's1', 'v2')
    const before = client.detachCalls
    await hub.detach('v1')
    expect(client.detachCalls).toBe(before)
    await hub.detach('v2')
    expect(client.detachCalls).toBe(before + 1)
  })

  it('rejects a session that is gone, with the host error code', async () => {
    const { hub, sender } = setup()
    await expect(hub.attach(sender, 'gone', 'v1')).rejects.toMatchObject({ code: 'not_found' })
    // And the hub stays usable.
    await expect(hub.attach(sender, 's1', 'v2')).resolves.toBeUndefined()
  })

  it('tells views when the process exits or the host connection drops', async () => {
    const { hub, client, ports, sender, broadcast } = setup()
    await hub.attach(sender, 's1', 'v1')
    client.emitEvent({ type: 'event', event: 'session-exited', id: 's1', exitCode: 3, signal: null })
    expect(ports[0]?.messages.at(-1)).toEqual({ t: 'exit', exitCode: 3, signal: null })
    expect(broadcast).toHaveLength(1)
    client.drop()
    expect(ports[0]?.messages.at(-1)).toEqual({ t: 'closed' })
    expect(ports[0]?.closed).toBe(true)
  })

  it('detaches every view of a window that goes away', async () => {
    const { hub, client, ports, sender, destroyed } = setup()
    await hub.attach(sender, 's1', 'v1')
    for (const listener of destroyed) listener()
    await hub.detach('v1')
    expect(ports[0]?.closed).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.detachCalls).toBe(1)
  })
})
