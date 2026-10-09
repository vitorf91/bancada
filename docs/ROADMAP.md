# Roadmap

Bancada is built in phases. Each phase is useful on its own and ends with an acceptance check that is measured, not assumed.

**v1 is done when** the author can uninstall the IDE they use today (desktop and phone) and go a full week without missing it.

| Phase | Delivers | Done when |
|---|---|---|
| **F0 Foundation and proofs** | Repo, tooling, CI, the pty-host contract, and five measured proofs: (a) 16 visible terminals with continuous agent-like output; (b) quitting, rebuilding, `kill -9`-ing and reopening the app with 10 live sessions; (c) dragging a worktree to a pane edge and saving/restoring the layout; (d) a PWA on an iPhone over Tailscale: open a session, type, get a push while locked; (e) answering a Bancada-hosted Claude session from the Claude app with `--remote-control`. | Every proof has a written result with numbers in `docs/proofs/F0.md`. |
| **F1 Terminal board** | Sidebar product → project → worktree (discovered from git, including existing worktrees and non-git folders), free tiling across worktrees and products, saved boards, terminals that survive the app, daily-driver terminal details (Shift+Enter for Claude Code, image paste, file drop, clickable paths, search, Option as Meta). | Two days of real use with 8+ agents across 3+ projects side by side, and 5 app updates without losing a session. |
| **F2 Agents and attention** | Agent state from hooks (working, waiting for you, done, error), an automatic "Attention" board, macOS notifications, one-click resume after reboot, new worktree with branch naming, `.env` copy, project setup and an agent preset, a `bancada` CLI for agents. | A waiting agent shows up within 2 s; after a reboot every agent session resumes with one click. |
| **F3 Phone** | PWA with push: Attention list, session view with send bar and quick keys, products → worktrees, changed files, new worktree with agent, photo/file upload, QR pairing, revocable devices. | One week using only the Bancada phone app, including on cellular; push within 10 s with the phone locked. |
| **F4 Files and diffs** | Side panel that follows the focused pane: tree, quick open, search, editor, Markdown and image preview, worktree and branch diffs, PR status. | A full agent PR is reviewed without leaving Bancada. |
| **F5 Weekly priorities** | Optional Notion integration: the week's priorities inside each product, "Start" turns one into a worktree with an agent. Read-only at first. | Starting work from a priority takes at most 3 clicks. |
| **F6 Open source polish** | README with screenshots, example config, build-from-source steps, CI. Distribution is this repo: build from source. | On a clean Mac, someone clones the repo, follows the README and runs the app with the example config. |

## Out of scope for v1

Agent orchestration, scheduled automations, embedded browser, computer use, emulators, remote hosts/SSH, account management, LSP/autocomplete, extensions, Windows and Linux.
