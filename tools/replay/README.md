# @bancada/replay

Records real terminal sessions, plays them back as the command of a PTY session, and generates synthetic agent-like output for CI. The format is [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/).

```sh
# Record (runs node-pty under Electron in node mode; never run electron-rebuild)
pnpm --filter @bancada/replay record -- --out <file.cast> --cmd "<command>" --cwd <dir> \
  --cols 120 --rows 40 --duration <s> [--input-script <json>]
# input script: [{"at": 1.5, "data": "hello\r"}, ...]  (seconds since start, bytes typed)

# Play: writes the output events to stdout with the original timing. Works as a PTY command.
pnpm --filter @bancada/replay replay -- --file <cast> [--speed 1] [--loop] [--max-delay 2]   # speed 0 = as fast as possible

# Inspect
pnpm --filter @bancada/replay replay -- stats <cast> [--json]
pnpm --filter @bancada/replay replay -- screen <cast> [--at <s>]     # plays into @xterm/headless, prints the screen

# Synthetic fixture (seeded, deterministic); the committed one is regenerated with:
pnpm --filter @bancada/replay generate:fixture
```

`record` builds `dist/` first, so it works from a clean checkout. A session is started with the environment hygiene from `docs/ARCHITECTURE.md` (no `ORCA_*`, `CLAUDECODE`, `CLAUDE_CODE_*`, ...), so a recorded `claude` does not report into another IDE.

Real recordings contain the user's status line and paths: keep them in `~/Library/Application Support/Bancada/fixtures/`, never in the repo (`*.cast` is git-ignored outside `fixtures/synthetic/`). Only `fixtures/synthetic/` is committed.
