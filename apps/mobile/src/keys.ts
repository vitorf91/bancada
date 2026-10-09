/** Quick keys of the session view: what each button types into the terminal. */
export interface QuickKey {
  label: string
  aria: string
  data: string
}

export const QUICK_KEYS: readonly QuickKey[] = [
  { label: 'Esc', aria: 'Esc', data: '\x1b' },
  { label: 'Tab', aria: 'Tab', data: '\t' },
  { label: '⇧Tab', aria: 'Shift Tab', data: '\x1b[Z' },
  { label: '↑', aria: 'Seta para cima', data: '\x1b[A' },
  { label: '↓', aria: 'Seta para baixo', data: '\x1b[B' },
  { label: '⌃C', aria: 'Control C', data: '\x03' },
  { label: '1', aria: 'Opção 1', data: '1' },
  { label: '2', aria: 'Opção 2', data: '2' },
  { label: '3', aria: 'Opção 3', data: '3' },
]
