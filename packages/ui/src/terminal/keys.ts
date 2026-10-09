/** What Shift+Enter sends: ESC then CR, which Claude Code reads as "newline without submitting". */
export const SHIFT_ENTER_SEQUENCE = '\x1b\r'

interface KeyLike {
  type: string
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  isComposing?: boolean
}

export function isShiftEnter(event: KeyLike): boolean {
  return (
    event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing
  )
}

/**
 * For xterm's `attachCustomKeyEventHandler`: returns false (xterm ignores the event) for Shift+Enter, after sending
 * the sequence on `keydown`. xterm turns the following `keypress` into a plain CR, so that one is swallowed too.
 */
export function createKeyHandler(send: (data: string) => void): (event: KeyboardEvent) => boolean {
  return (event) => {
    if (!isShiftEnter(event)) return true
    if (event.type === 'keydown') {
      event.preventDefault()
      send(SHIFT_ENTER_SEQUENCE)
    }
    return false
  }
}
