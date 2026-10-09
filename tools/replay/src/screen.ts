import xtermHeadless from '@xterm/headless'
import type { Asciicast } from './asciicast.js'

const { Terminal } = xtermHeadless

/** Plays the output events (up to `until` seconds) into a headless xterm and returns the visible screen, one string per row. */
export async function renderFinalScreen(
  cast: Asciicast,
  until = Number.POSITIVE_INFINITY,
): Promise<{ lines: string[]; title: string }> {
  const term = new Terminal({
    cols: cast.header.width,
    rows: cast.header.height,
    scrollback: 1000,
    allowProposedApi: true,
  })
  let title = ''
  term.onTitleChange((t) => {
    title = t
  })
  for (const event of cast.events) {
    if (event.code === 'o' && event.time <= until) term.write(event.data)
  }
  await new Promise<void>((done) => term.write('', done))
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < term.rows; y++) lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '')
  term.dispose()
  return { lines, title }
}
