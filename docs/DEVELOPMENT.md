# Development

## Setup

Pinned toolchains: Node.js 24.19.0, npm 11.17.0, Python 3.12.10, Rust 1.97.1 (`rust-toolchain.toml`)
and Tauri CLI 2.11.4. Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/),
then from the repository root:

```powershell
npm ci
npm --prefix apps/desktop ci
npm run tauri:dev
```

`tauri:dev` starts Vite on port 3030 and the debug app. It works offline: the delivery catalogs are
checked locally by the desktop build script, and the remote pool read-back runs in CI
(`npm run verify:managed-delivery`). `npm run dev:vite` serves the frontend alone, but browser mode
cannot run native commands.

## Verification

Two commands cover what CI checks:

```powershell
npm run verify          # lint, i18n, Tauri contract, versions, script and gate tests,
                        # compile readiness, e2e contracts, vitest
npm run verify:native   # cargo fmt --check, clippy -D warnings, cargo test --no-fail-fast
```

`verify:native` needs no GPU, but the export and parity tests only run on a hardware GPU. On a
software adapter (hosted CI runners) they print `SKIPPED ... NOT verified`, so run
`verify:native` on a GPU machine before a release.

CI (`.github/workflows/rewrite-ci.yml`) additionally audits production dependencies, runs the
Python worker contracts (`npm run test:python-workers`), verifies the managed-delivery pool
remotely, builds the frontend, compiles the Tauri app without bundling, and enforces the payload
budget (`npm run check:desktop-payload-size`). Manual dispatches (`-f job=...`) run the installer,
signed-updater and published-installer smokes; see [release/RELEASING.md](release/RELEASING.md).

Release-readiness checks live in `scripts/release-readiness/`, one module per concern. They guard
outcomes (toolchain pins, CI credential scope, Tauri/CSP/updater config, delivery catalogs,
notices, compiled-out test seams). They must not pin source wording; delete a check that does.

## Managed builds and the cache

Always build through the npm commands (`cargo:clippy`, `cargo:test`, `tauri:dev`, `tauri:build`,
`build:frontend`, `build:e2e-binary`). They take a lease on a lane of the external cache at
`%LOCALAPPDATA%\OSG-Development\cache` (or `OSG_DEV_CACHE_ROOT`) and put Cargo targets and frontend
output there, never under the repository. The inner `apps/desktop` scripts refuse to run outside
that lease, and a plain `cargo build --release` is refused because it would embed the Vite dev URL.

`scripts/dev-cache.ps1` owns the cache: lanes idle for 14 days are removed, then the oldest lanes go
until the cache is under 28 GiB. Leased or in-use lanes are never touched. Deletion goes through a journaled `.trash` move, so a
killed prune resumes safely. The wrapper prunes after every command and, at most every 15 minutes,
before one too.

```powershell
npm run cache:status
npm run cache:prune          # dry run
npm run cache:prune:apply
npm run test:dev-cache       # cache manager and wrapper tests (pwsh + node)
```

## Real-binary journeys (Windows)

`e2e/` drives a built E2E-channel binary through an embedded WebDriver server (compiled only with
the `e2e-automation` feature). Each run gets an isolated data root.

```powershell
npm run build:e2e-binary
npm --prefix e2e test           # contract tests, then the startup and default-font journeys
npm --prefix e2e run test:all   # every journey and scenario
```

Single journeys have their own scripts in `e2e/package.json`.

`scripts/test-installed-windows.ps1` installs the real NSIS bundle and only runs on a disposable CI
runner. `scripts/test-installed-local.ps1` runs it on a developer machine inside guards; see
[rewrite/INSTALLED_SMOKE_LOCAL.md](rewrite/INSTALLED_SMOKE_LOCAL.md). To inspect what an installer
ships without running it:

```powershell
npm run check:installer-payload -- --installer "<path to setup.exe>"
```

## Delivery catalogs

Optional tools, engines, models, the UI font and voice samples are downloaded on demand from the
reviewed catalogs in `crates/*/delivery/`. Sources are, in order: the upstream publisher's
immutable release, then the append-only `osg-runtime-bundles-v1` pool (content-addressed names,
never overwritten). When a package source changes:

1. Build the package outside the tree, give it a content-addressed name, upload it to the pool and
   read it back.
2. Update the catalog and run `python -I -B scripts/check-managed-delivery-contract.py --write`.
3. Run `npm run verify:managed-delivery` and commit sources, catalog and checkpoint together.

## Logs and data

Native diagnostics go to `%LOCALAPPDATA%\io.github.nganlinh4.oneclicksubtitles\logs\osg.log` (one
rotated previous file). Projects and settings are in SQLite under the same folder; credentials are
in Windows Credential Manager.

To import data from the legacy 2.x app, press `Ctrl+Alt+Shift+I` in the desktop app and pick the
old data folder. The import copies supported settings, credentials and artifacts, leaves the source
untouched, is safe to retry, and takes effect after a restart.
