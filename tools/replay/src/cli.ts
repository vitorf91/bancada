import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parseAsciicast, serializeAsciicast } from './asciicast.js'
import { DEFAULT_GENERATE_OPTIONS, generateAsciicast } from './generator.js'
import { play } from './player.js'
import { renderFinalScreen } from './screen.js'
import { computeStats, formatStats } from './stats.js'

const USAGE = `replay: play, inspect and generate asciicast v2 recordings

  replay --file <cast> [--speed 1] [--loop] [--max-delay <s>]   write the output events to stdout with original timing
  replay generate --out <file> [--seed 1] [--duration 85] [--cols 120] [--rows 40] [--intensity 1]
                                                                synthetic agent-like session, deterministic per seed
  replay stats <file> [--json]                                  duration, bytes, events, bytes/s, escape share
  replay screen <file> [--at <s>]                                    print the final screen (plays the file into xterm)

--speed 0 plays as fast as possible. Recording: pnpm --filter @bancada/replay record -- --help`

function readCast(path: string) {
  return parseAsciicast(readFileSync(resolve(path), 'utf8'))
}

async function runPlay(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      file: { type: 'string' },
      speed: { type: 'string', default: '1' },
      loop: { type: 'boolean', default: false },
      'max-delay': { type: 'string' },
    },
  })
  if (!values.file) {
    console.error(USAGE)
    return 2
  }
  const cast = readCast(values.file)
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => controller.abort())
  let broken = false
  process.stdout.on('error', () => {
    broken = true
    controller.abort()
  })
  await play(cast.events, {
    speed: Number(values.speed),
    loop: values.loop,
    maxDelay: values['max-delay'] === undefined ? undefined : Number(values['max-delay']),
    signal: controller.signal,
    write: (data) => {
      if (broken || process.stdout.write(data)) return
      return new Promise<void>((done) => process.stdout.once('drain', done))
    },
  })
  return 0
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'))
  const [command, ...rest] = argv
  switch (command) {
    case 'stats': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { json: { type: 'boolean' } },
        allowPositionals: true,
      })
      if (!positionals[0]) {
        console.error(USAGE)
        return 2
      }
      const stats = computeStats(readCast(positionals[0]))
      console.log(values.json ? JSON.stringify(stats, null, 2) : formatStats(stats))
      return 0
    }
    case 'screen': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { at: { type: 'string' } },
        allowPositionals: true,
      })
      if (!positionals[0]) {
        console.error(USAGE)
        return 2
      }
      const until = values.at === undefined ? undefined : Number(values.at)
      const { lines, title } = await renderFinalScreen(readCast(positionals[0]), until)
      console.log(`title: ${title}\n${lines.join('\n')}`)
      return 0
    }
    case 'generate': {
      const { values } = parseArgs({
        args: rest,
        options: {
          out: { type: 'string' },
          seed: { type: 'string' },
          duration: { type: 'string' },
          cols: { type: 'string' },
          rows: { type: 'string' },
          intensity: { type: 'string' },
        },
      })
      if (!values.out) {
        console.error(USAGE)
        return 2
      }
      const d = DEFAULT_GENERATE_OPTIONS
      const cast = generateAsciicast({
        seed: Number(values.seed ?? d.seed),
        durationSec: Number(values.duration ?? d.durationSec),
        cols: Number(values.cols ?? d.cols),
        rows: Number(values.rows ?? d.rows),
        intensity: Number(values.intensity ?? d.intensity),
      })
      const out = resolve(values.out)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, serializeAsciicast(cast))
      console.error(`wrote ${out}`)
      return 0
    }
    case 'play':
      return runPlay(rest)
    case undefined:
    case '-h':
    case '--help':
      console.log(USAGE)
      return 0
    default:
      return runPlay(argv)
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)
