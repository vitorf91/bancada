/** "agora", "há 5 s", "há 3 min", "há 2 h", "há 4 d" for a past timestamp. */
export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 3) return 'agora'
  if (seconds < 60) return `há ${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `há ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `há ${hours} h`
  return `há ${Math.floor(hours / 24)} d`
}

/** Pairing codes are typed by hand: ignore case, spaces and dashes. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '')
}

export function formatCodeInput(raw: string): string {
  const code = normalizeCode(raw).slice(0, 8)
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
}

/** A sensible default for the "device name" field from the user agent. */
export function guessDeviceName(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return 'iPhone'
  if (/iPad/.test(userAgent)) return 'iPad'
  if (/Android/.test(userAgent)) return 'Android'
  return 'Navegador'
}
