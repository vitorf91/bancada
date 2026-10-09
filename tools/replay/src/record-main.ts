/** Entry point of the recorder. Runs under Electron in node mode, started by scripts/record.mjs. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parseInputScript, record } from './recorder.js'

const USAGE = `usage: record --out <file.cast> --cmd "<command>" [--cwd <dir>] [--cols 120] [--rows 40] --duration <s> [--input-script <json>]`

async function main(): Promise<number> {
  const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'))
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      cmd: { type: 'string' },
      cwd: { type: 'string' },
      cols: { type: 'string', default: '120' },
      rows: { type: 'string', default: '40' },
      duration: { type: 'string' },
      'input-script': { type: 'string' },
    },
  })
  if (!values.out || !values.cmd || !values.duration) {
    console.error(USAGE)
    return 2
  }
  const cols = Number(values.cols)
  const rows = Number(values.rows)
  const duration = Number(values.duration)
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || !(duration > 0)) {
    console.error(`invalid --cols, --rows or --duration\n${USAGE}`)
    return 2
  }
  const input = values['input-script']
    ? parseInputScript(readFileSync(resolve(values['input-script']), 'utf8'))
    : undefined
  const result = await record({
    out: resolve(values.out),
    cmd: values.cmd,
    cwd: resolve(values.cwd ?? process.cwd()),
    cols,
    rows,
    duration,
    input,
  })
  // Numbers only: never echo what the session printed.
  console.error(
    `recorded ${result.durationSec.toFixed(1)} s, ${result.outputEvents} output events (${result.outputBytes} bytes), ` +
      `${result.inputEvents} input events, exit ${result.exitCode}${result.signal ? ` signal ${result.signal}` : ''}` +
      `${result.exitedEarly ? ' (process ended on its own)' : ' (stopped at --duration)'}`,
  )
  return 0
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)
