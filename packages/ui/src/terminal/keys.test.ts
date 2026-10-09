import { describe, expect, it } from 'vitest'
import { createKeyHandler, SHIFT_ENTER_SEQUENCE } from './keys.js'

function key(type: string, init: Partial<KeyboardEvent> = {}) {
  const event = { type, key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...init }
  return Object.assign(event, { preventDefault: () => {} }) as unknown as KeyboardEvent
}

describe('Shift+Enter', () => {
  it('sends ESC CR once and keeps xterm from sending a CR', () => {
    const sent: string[] = []
    const handler = createKeyHandler((data) => sent.push(data))
    expect(handler(key('keydown', { shiftKey: true }))).toBe(false)
    expect(handler(key('keypress', { shiftKey: true }))).toBe(false)
    expect(sent).toEqual([SHIFT_ENTER_SEQUENCE])
    expect(SHIFT_ENTER_SEQUENCE).toBe('\x1b\r')
  })

  it('leaves plain Enter and other chords to xterm', () => {
    const sent: string[] = []
    const handler = createKeyHandler((data) => sent.push(data))
    expect(handler(key('keydown'))).toBe(true)
    expect(handler(key('keydown', { shiftKey: true, ctrlKey: true }))).toBe(true)
    expect(handler(key('keydown', { key: 'a', shiftKey: true }))).toBe(true)
    expect(sent).toEqual([])
  })
})
