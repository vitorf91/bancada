/**
 * Chromium keeps about 16 live WebGL contexts per page, and each WebGL terminal also costs GPU memory. The budget
 * hands the slots to the most recently active visible terminals; the rest render with the DOM renderer.
 */
export class WebglBudget {
  /** Visible terminals, most recently active first. */
  private order: string[] = []
  private readonly listeners = new Map<string, (granted: boolean) => void>()
  private readonly lost = new Set<string>()
  private limit: number
  private granted = new Set<string>()

  constructor(limit: number) {
    this.limit = limit
  }

  get size(): number {
    return this.limit
  }

  setLimit(limit: number): void {
    this.limit = limit
    this.recompute()
  }

  /** Adds a visible terminal as the least recently active one. Returns the unregister function. */
  register(id: string, listener: (granted: boolean) => void): () => void {
    this.listeners.set(id, listener)
    this.order = this.order.filter((other) => other !== id)
    this.order.push(id)
    this.recompute()
    return () => {
      this.listeners.delete(id)
      this.order = this.order.filter((other) => other !== id)
      this.lost.delete(id)
      this.recompute()
    }
  }

  /** The terminal gained focus or was typed into: it becomes the most recent. */
  touch(id: string): void {
    if (!this.listeners.has(id) || this.order[0] === id) return
    this.order = [id, ...this.order.filter((other) => other !== id)]
    this.recompute()
  }

  /** A hidden terminal gives its slot up; showing it again puts it back as the least recent one. */
  setVisible(id: string, visible: boolean): void {
    if (!this.listeners.has(id)) return
    this.order = this.order.filter((other) => other !== id)
    if (visible) this.order.push(id)
    this.recompute()
  }

  /** The context was lost: this terminal stays on the DOM renderer and its slot goes to the next one. */
  markLost(id: string): void {
    this.lost.add(id)
    this.recompute()
  }

  isGranted(id: string): boolean {
    return this.granted.has(id)
  }

  private recompute(): void {
    const next = new Set<string>()
    for (const id of this.order) {
      if (next.size >= this.limit) break
      if (!this.lost.has(id)) next.add(id)
    }
    const before = this.granted
    this.granted = next
    for (const id of this.order) {
      if (before.has(id) !== next.has(id)) this.listeners.get(id)?.(next.has(id))
    }
    for (const id of before) {
      if (!next.has(id) && !this.order.includes(id)) this.listeners.get(id)?.(false)
    }
  }
}

/** Shared by the terminals of one window. The F0 bench picked the default limit (docs/proofs/F0-a.md). */
export const DEFAULT_WEBGL_LIMIT = 4
export const webglBudget = new WebglBudget(DEFAULT_WEBGL_LIMIT)
