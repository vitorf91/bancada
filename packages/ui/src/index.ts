export type { Terminal } from '@xterm/xterm'
export { TerminalController, type TerminalControllerOptions } from './terminal/controller.js'
export { createKeyHandler, isShiftEnter, SHIFT_ENTER_SEQUENCE } from './terminal/keys.js'
export { TerminalView, type TerminalViewProps } from './terminal/TerminalView.js'
export {
  DEFAULT_SCROLLBACK_LINES,
  type TerminalConnect,
  type TerminalConnectOptions,
  type TerminalEvent,
  TerminalGoneError,
  type TerminalLink,
  type TerminalRendererKind,
  type TerminalRendererReason,
  type TerminalSnapshot,
  type TerminalStatus,
  type TerminalStatusDetail,
} from './terminal/types.js'
export { DEFAULT_WEBGL_LIMIT, WebglBudget, webglBudget } from './terminal/webgl-budget.js'
export { Wordmark } from './wordmark.js'
