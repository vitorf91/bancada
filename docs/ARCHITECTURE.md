# Bancada architecture

Bancada is a macOS app where any terminal from any git worktree, project or product can sit side by side, with files and diffs in a side panel and a phone companion that tells you when an agent needs you. It does not reimplement coding agents: Claude Code, Codex and plain shells run as they are.

This document is the contract between the parts. Change it in the same PR that changes the behavior.

## Processes

| Process | Owns | Restart kills terminals? |
|---|---|---|
| **pty-host** | PTYs, per-session headless mirror and scrollback. No product logic. Changes rarely. | It *is* the thing holding terminals. Restarting it is the only event that ends live sessions. |
| **server** | HTTP/WebSocket API for the phone (PWA) and, later, git/worktrees, agent state, notifications, CLI API. Client of pty-host. | No |
| **desktop** (Electron main + renderer) | UI only. Main process is a pty-host client (direct in F0; may move behind the server later). | No |
| **cli** (later) | Commands for the user, agents and hooks. | No |

### pty-host runtime (decided)

- The pty-host always runs under **Electron's binary in node mode** (`ELECTRON_RUN_AS_NODE=1`), in production and in tests. Tests get the binary path from `require('electron')`. It never runs under system Node, whose version the user can change.
- It is bundled into a single JS file and copied, together with node-pty's native addon, to a versioned runtime dir `<dataDir>/runtime/pty-host-<version>/` before launch. Rebuilding or replacing the app never touches the files a running host uses.
- It is launched detached (`detached: true`, `stdio: 'ignore'`, `unref()`), so it outlives the app.
- node-pty is used through its N-API prebuilt binary. Nobody runs `electron-rebuild` / `install-app-deps` against it. If a rebuild ever becomes unavoidable, it targets Electron, because Electron is the only runtime that loads it.
- The test runner (Vitest, system Node) only acts as a **client**: it imports the pure-JS client and spawns the host through the Electron binary.

## Data dir and profiles

- `BANCADA_PROFILE` selects the profile (default `default`; dev builds use `dev`). Data dir: `~/Library/Application Support/Bancada/<profile>`.
- `BANCADA_DATA_DIR` overrides the data dir. **Tests always use `fs.mkdtemp` under `/tmp`**, never a real profile and never a path inside the repo or a worktree (socket path limit, below).
- Electron calls `app.setPath('userData', dataDir)` before `ready`, so the single-instance lock, Chromium data and the pty-host socket all live per profile. A dev build can run next to the stable app without touching its sessions.
- pty-host socket: `<dataDir>/pty-host.sock`, mode `0600`. macOS limits `sun_path` to 104 bytes: if the path is 100 bytes or longer, use `/tmp/bancada-<uid>/<first 12 hex of sha1(dataDir)>.sock` (dir mode `0700`).
- pty-host pid/lock file: `<dataDir>/pty-host.pid`. A second host for the same data dir refuses to start.
- Private fixtures (real session recordings) live in `~/Library/Application Support/Bancada/fixtures/` and **never** enter the repo. CI uses committed synthetic fixtures.

## Session environment hygiene

The host is often launched from a shell that belongs to another terminal app or agent session, so its own environment is contaminated. The session environment is built **at spawn time**:

1. Start from the host's environment.
2. Remove: `ORCA_*`, `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `VSCODE_*`, `ITERM_*`, `GHOSTTY_*`, `KITTY_*`, `WEZTERM_*`, `TMUX`, `TMUX_PANE`.
3. Set: `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Bancada`, `TERM_PROGRAM_VERSION=<app version>`, `LANG=en_US.UTF-8` if `LANG` is unset, `BANCADA_SESSION_ID`, `BANCADA_PROFILE`.
4. Apply `spec.env` last.

Default command: the user's login shell (`$SHELL`, falling back to `os.userInfo().shell`) with `-l`, so PATH and the user's rc files load even when the app was started from Finder.

## pty-host protocol v1

Types live in `packages/protocol/src/pty.ts`.

**Transport.** Unix socket, length-prefixed frames: `u32be length | u8 kind | payload`, where `length` counts `kind + payload`.

| kind | Direction | Payload |
|---|---|---|
| 1 `Control` | both | UTF-8 JSON: a `ClientRequest` or a `HostMessage` |
| 2 `Output` | host → client | `u8 idLength`, session id (ASCII), raw output bytes |
| 3 `Input` | client → host | `u8 idLength`, session id (ASCII), raw input bytes |

Binary frames carry terminal I/O so output never pays for base64 or JSON.

**Semantics.**

- `hello` comes first. The host replies with `protocol`, `hostVersion`, `pid`, `startedAt`. On a major protocol mismatch the client reports an error and **never** kills the host (that would kill every session).
- `attach(id)` streams a session to this connection. The host takes a cutoff: output that arrived before the cutoff is in the snapshot, output after it is streamed. Implementation: on attach, start buffering this session's output for this client, call `headless.write('', cb)`, and inside `cb` (all pre-cutoff data parsed) serialize the mirror with `SerializeAddon` (scrollback up to the requested lines), reply with the snapshot, then flush the buffer and stream live. No gaps, no duplicates.
- `detach(id)` stops streaming that session to this connection. The renderer only attaches sessions that are visible.
- Output to clients is coalesced per session: flush at most every 8 ms or at 64 KiB.
- Many clients may attach the same session. All receive output and any can write.
- `resize` applies immediately and the last one wins. Clients send a resize when they gain focus or start typing, so the size follows the last active client (desktop or phone).
- When the process exits, the host keeps the session (`state: 'exited'`, exit code, final snapshot) until `dispose`, and broadcasts `session-exited`.
- Title changes from the terminal (OSC 0/2) are broadcast as `session-title`. Claude Code writes its topic there.
- The host never exits on its own while sessions are alive. `shutdown` without `force` is refused while sessions are alive.
- Persistence (F1): metadata in `<dataDir>/sessions/<id>.json` plus a periodic snapshot, so after a host restart sessions show as `lost` with their last screen and a resume command.

## Renderer terminals

- xterm.js **6.0.0 stable**, paired addons: `@xterm/addon-webgl` 0.19.0, `@xterm/addon-serialize` 0.14.0, `@xterm/headless` 6.0.0 (host side). No beta channels: addon majors must match the core.
- Visible panes attach, hidden panes detach. The WebGL budget (Chromium keeps about 16 live contexts per page) is decided by the F0 terminal-grid proof.

## Phone

The server binds to `127.0.0.1` only. The phone reaches it through `tailscale serve` (HTTPS on the tailnet, nothing on the public internet), plus a per-device token. Push uses Web Push (VAPID), with the private key in the macOS Keychain.

## Secrets and personal data

Never in the repo: device tokens, VAPID private keys, Notion tokens, the user's `~/.config/bancada/config.toml`, session recordings. Secrets go to the macOS Keychain. CI runs a secret scan on every push.
