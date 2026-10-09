// Entry of the bundle: `electron --run-as-node dist/server.mjs <command>` (see scripts/launch.mjs).
import { main } from './cli.js'

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code)
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)
