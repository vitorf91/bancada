import type { ITheme } from '@xterm/xterm'

/** `--term-<token>` custom property → xterm theme key. */
const THEME_TOKENS: Record<string, Exclude<keyof ITheme, 'extendedAnsi'>> = {
  bg: 'background',
  fg: 'foreground',
  cursor: 'cursor',
  selection: 'selectionBackground',
  black: 'black',
  red: 'red',
  green: 'green',
  yellow: 'yellow',
  blue: 'blue',
  magenta: 'magenta',
  cyan: 'cyan',
  white: 'white',
  'bright-black': 'brightBlack',
  'bright-red': 'brightRed',
  'bright-green': 'brightGreen',
  'bright-yellow': 'brightYellow',
  'bright-blue': 'brightBlue',
  'bright-magenta': 'brightMagenta',
  'bright-cyan': 'brightCyan',
  'bright-white': 'brightWhite',
}

/** The terminal palette comes from `--term-*` custom properties (the app's tokens); xterm's defaults fill any gap. */
export function readTerminalTheme(element: Element): ITheme {
  const style = getComputedStyle(element)
  const theme: ITheme = {}
  for (const [token, key] of Object.entries(THEME_TOKENS)) {
    const value = style.getPropertyValue(`--term-${token}`).trim()
    if (value) theme[key] = value
  }
  if (theme.background) theme.cursorAccent = theme.background
  return theme
}

export function readTerminalFont(element: Element): { family?: string; size?: number; lineHeight?: number } {
  const style = getComputedStyle(element)
  const size = Number.parseFloat(style.getPropertyValue('--term-font-size'))
  const lineHeight = Number.parseFloat(style.getPropertyValue('--term-line-height'))
  return {
    family: style.getPropertyValue('--term-font').trim() || undefined,
    size: Number.isFinite(size) ? size : undefined,
    lineHeight: Number.isFinite(lineHeight) ? lineHeight : undefined,
  }
}
