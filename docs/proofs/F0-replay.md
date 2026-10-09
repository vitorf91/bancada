# F0 proof: replay harness

`tools/replay` records real sessions, plays them back as the command of a PTY, and generates synthetic output with similar statistics for CI. This page holds the numbers; the real recording stays private (it contains the user's status line) in `~/Library/Application Support/Bancada/fixtures/` and is never committed.

## The real recording

One Claude Code TUI session, recorded with `pnpm --filter @bancada/replay record`:

- command `claude --model haiku --dangerously-skip-permissions`, 120x40, fresh empty working directory;
- environment: the host's, minus the strip list in `docs/ARCHITECTURE.md`, plus `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Bancada`;
- scripted input: accept the folder-trust prompt, type one prompt (the agent thinks, writes a markdown file of about 50 lines and shows it), then `/exit`;
- the process ended on its own at 81.6 s (exit code 0), so the 95 s limit did not fire.

**Check.** The file was played into an `@xterm/headless` 6.0.0 terminal (`replay screen <file> --at <s>`). The screen just before `/exit` shows real Claude Code UI: the prompt box, the tool-call lines, the agent's reply, a prompt suggestion and the two footer lines (permission mode and status line). After `/exit` Claude Code leaves the alternate screen, so the very last frame is the normal screen with its resume hint; that is the expected end of the stream, not a truncated recording.

## Side by side

Measured by `replay stats <file>`. A "1 s window" is a fixed window `[n, n+1)` seconds. Escape share is the fraction of output bytes that belong to escape sequences (CSI, OSC, DCS and ESC pairs); plain CR, LF and BS count as text.

| metric | real recording | synthetic `agent-like.cast` |
|---|---:|---:|
| duration (s) | 81.62 | 85.00 |
| output bytes | 44 533 | 45 368 |
| output events | 291 | 324 |
| input events | 68 | 0 |
| average bytes/s | 545.6 | 533.7 |
| peak bytes/s (1 s window) | 12 544 | 12 626 |
| escape share | 65.8 % | 61.0 % |
| truecolor SGR sequences | 535 | 713 |
| 256-color SGR sequences | 0 | 351 |
| cursor-move sequences | 2 306 | 1 332 |
| OSC 0/2 title changes | 26 | 24 |
| box-drawing characters | 720 | 2 186 |
| wide characters (CJK, emoji) | 5 | 91 |
| events of at least 1000 bytes | 17 | 18 |

Event sizes top out at 1024 bytes in both (the PTY read size). In the real session most of the traffic is a spinner repainted about 12 times a second at roughly 70 bytes per event, one burst of about 12.5 KB while the file is written and shown, and a 31 s stretch with nothing but a footer refresh.

The synthetic generator is not tuned to match every row. The feature counts the spec asks for but Claude Code hardly uses (256-color SGR, wide characters, box drawing) are higher on purpose; the rate profile (average, peak, event size, burst then idle) is what it is calibrated against.

## Synthetic fixture

`tools/replay/fixtures/synthetic/agent-like.cast` (69 KB) is deterministic: the same seed gives the same bytes, and a test fails if the committed file differs from what the command produces.

```sh
pnpm --filter @bancada/replay generate:fixture
# = replay generate --seed 4 --duration 85 --cols 120 --rows 40 --out tools/replay/fixtures/synthetic/agent-like.cast
```

Seed 4 was picked among seeds 1 to 8 because it is closest to the recording. The spread over those eight seeds, with the same parameters:

| metric | range over seeds 1-8 | real |
|---|---:|---:|
| average bytes/s | 534 to 746 | 545.6 |
| peak bytes/s | 9 629 to 12 626 | 12 544 |
| escape share | 61.0 % to 62.2 % | 65.8 % |
| output events | 324 to 499 | 291 |

`--intensity N` divides the idle gaps by N for a busier agent (the 16-terminal proof can use it); the committed fixture uses 1.

## Reproduce

```sh
pnpm --filter @bancada/replay record -- --out <file.cast> --cmd "claude --model haiku --dangerously-skip-permissions" \
  --cwd "$(mktemp -d)" --cols 120 --rows 40 --duration 95 --input-script <json>
pnpm --filter @bancada/replay replay -- stats <file.cast>
pnpm --filter @bancada/replay replay -- screen <file.cast> --at <seconds before /exit>
```
