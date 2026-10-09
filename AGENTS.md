# Bancada: agent instructions

Bancada is a macOS Electron IDE for running many terminal coding agents side by side. The contract between the parts is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the plan is [docs/ROADMAP.md](docs/ROADMAP.md). Change a document in the same PR that changes the behavior it describes.

## Layout

pnpm workspace (`pnpm-workspace.yaml`): `apps/desktop` (Electron + React), `apps/mobile` (PWA), `packages/protocol`, `packages/pty-host`, `packages/server`, `packages/ui`, `tools/replay`.

- Internal packages export their TypeScript source (`"exports": "./src/index.ts"`). Nothing is emitted with `tsc`; every runtime artifact is bundled (electron-vite for desktop, esbuild for pty-host and server).
- Workspace packages go in `devDependencies` of the app that bundles them. electron-vite externalizes everything under `dependencies`, and Electron cannot load a `.ts` file at runtime.
- Every package defines a `typecheck` script (`pnpm typecheck` runs the root config and `pnpm -r typecheck`). A package without one is not covered.
- Shared tool versions live in the `catalog:` of `pnpm-workspace.yaml`.

## Checks

- `pnpm check` always (typecheck, lint, test, build, failing fast). `pnpm format` fixes formatting and import order (Biome).
- `pnpm --filter @bancada/desktop e2e` for any change to Electron or the UI. It builds the app, opens a real window and runs the Playwright smoke test. It is not part of `pnpm check` or CI yet.
- Do not skip or weaken a check to get green. A failing gate is fixed, or recorded with the command that reproduces it.

## Conventions

- Code, comments and commits in English. Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`).
- One branch and one PR per change. No direct pushes to `main` after the initial commit. One agent per git worktree.
- Biome formats: 2 spaces, single quotes, no semicolons, line width 120.
- Tests use `fs.mkdtemp` data dirs under `/tmp` (`BANCADA_DATA_DIR`) and never touch a real profile, nor a path inside the repo or a worktree (socket path limit, see the architecture doc).
- `pnpm dev` runs the desktop app with `BANCADA_PROFILE=dev`, so it never shares data with the stable app.

## Runtime rules

- **pty-host** always runs under Electron's binary in node mode (`ELECTRON_RUN_AS_NODE=1`), in production and in tests, never under system Node. node-pty is used through its N-API prebuilt binary: never run `electron-rebuild` or `install-app-deps` against it. If a rebuild becomes unavoidable, it targets Electron.
- **Session environment hygiene**: a session's environment is built at spawn time from the host's, minus the terminal-app and agent variables, plus the `TERM`/`BANCADA_*` ones. The exact list is in the architecture doc and `STRIPPED_ENV_*` in `packages/protocol/src/pty.ts`.
- **xterm versions are pinned** exactly (no `^`) to the set in the architecture doc: core 6.0.0 stable with its matching addons. No beta channels, and addon majors must match the core.

## Secrets and personal data

Never commit tokens, VAPID private keys, `~/.config/bancada/config.toml`, `.env*` files or session recordings. Private fixtures live in `~/Library/Application Support/Bancada/fixtures/`; only synthetic ones are committed, under `tools/replay/fixtures/synthetic/`. CI runs gitleaks on every push, and you can run `gitleaks detect --source .` locally.

## Toolchain notes

- TypeScript 7 (native compiler) works with the whole toolchain, so there is no pin to 6.x.
- Vite is pinned to 7.x because electron-vite 5 peers on `vite ^5 || ^6 || ^7`; `@vitejs/plugin-react` is therefore 5.x (6.x needs Vite 8). Move both together when electron-vite supports Vite 8.
