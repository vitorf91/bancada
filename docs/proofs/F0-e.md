# F0 proof (e): answer a Bancada-hosted Claude session from the Claude app

**Result: prepared, pending the user.** `claude --remote-control` runs inside a Bancada pty-host session and registers a Remote Control session. The last step, answering from the Claude app, is the user's.

## What was run (Mac side)

Claude Code 2.1.296, on the user's logged-in account.

1. A pty-host on a `mkdtemp` data dir under `/tmp`, launched through `ensureHost` (Electron node mode). The session was spawned by the host with its environment hygiene (no `CLAUDECODE`, `CLAUDE_CODE_*`, `ORCA_*`, `TERM_PROGRAM` replaced), `cwd` = a fresh `mkdtemp` directory, command `claude`, args `--remote-control`, 120x40.
2. No prompt was typed to the model at any point.
3. Steps taken and what the screen showed:

| Step | What appeared (redacted) |
|---|---|
| Right after launch | The folder trust dialog: "Accessing workspace: `<mkdtemp dir>`", "Quick safety check: Is this a project you created or one you trust?", options `No, exit` (selected by default) and `Yes, I trust this folder`. |
| After choosing "Yes, I trust this folder" (Down, Enter) | The Claude Code banner (version, model, plan, the folder) and, under it, `/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_<id>` (URL redacted: it carries the session id). The prompt box showed the usual placeholder. No QR code was drawn on the screen and no error appeared. The status line showed `auto mode on`. |
| 30 s later | Unchanged: Remote Control stayed active, no reconnect or error message. |
| Exit | Typed `/exit` and Enter. The screen printed `Resume this session with: claude --resume <id>`; the process exited with code 0 (`session-exited`, `exitCode: 0`). The host and the temp dirs were removed. |

Side effects to know about: answering the trust dialog records the temp folder as trusted in `~/.claude.json` (a stale entry for a `/tmp` path that no longer exists), and the Remote Control session was registered with the account while it ran; it ended with the process.

## What the user does to finish it

1. In a terminal hosted by Bancada (a pane of the desktop app, which spawns its sessions through the same pty-host; with the server of proof (d) running it also shows on the phone), `cd` into a **throwaway folder** and run `claude --remote-control`. Pick "Yes, I trust this folder".
2. The screen prints `/remote-control is active ... https://claude.ai/code/session_<id>`.
3. Open the Claude app on the phone (or claude.ai/code) with the same account: the session appears in the list. Open it.
4. Send a prompt such as "reply with the word pong" **from the app**.
5. Check that the answer appears in the app **and** in the Bancada terminal (look at it on the desktop, or on the phone PWA from proof (d)). That is the proof: one session, answered from the Claude app, hosted by Bancada.
6. Exit with `/exit`.

Record: whether the session showed up, how long the answer took, and anything the Claude app refused. Not tested here: that the app can answer (needs a prompt, which was forbidden for this prep).
