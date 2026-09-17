# OSG development guide

Developer operations for the canonical native application. See the [Windows release checklist](release/WINDOWS-1.0-VALIDATION.md) for release approval.

## Run from source

Required toolchains are pinned to Node.js 24.19.0, npm 11.17.0, Python 3.12.10,
Rust 1.97.1, and Tauri CLI 2.11.4.
Install the
[Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system,
then run from the repository root:

```powershell
npm ci
npm --prefix apps/desktop ci
npm run tauri:dev
```

Tauri starts Vite automatically. `npm run dev:vite` is available for frontend-only inspection, but
browser mode cannot exercise native commands and is not a functional replacement for the desktop
app. The public frontend commands (`dev:vite`, `build:vite`, `build:promptdj`, and
`build:frontend`) also acquire the bounded external `dev` lane; they do not write Vite caches,
PromptDJ output, version metadata, or `build/` into the repository. Tauri invokes separately named
guarded inner scripts under its existing dev/package lease, so its hooks never nest another cache
manager. Those inner scripts reject unmanaged local use. GitHub Actions uses the explicit inner
route only after validating the complete runner/workspace identity; setting `CI=true` or
`GITHUB_ACTIONS=true` in a local shell grants no bypass.

To compile without creating an installer:

```powershell
npm run build:frontend
npm run cargo:check
npm run tauri:build -- --no-bundle
```

Use `npm run tauri:build` to create installers. Do not invoke `cargo build --release` directly:
Tauri's production command enables the custom protocol that embeds the frontend, while a plain Cargo
release would retain the Vite development URL. The crate intentionally rejects that unsafe build.

## Verification

The main local gates are:

```powershell
npm audit --omit=dev --audit-level=high
npm run check:dependencies
npm run lint
npm test
npm run check:i18n
npm run check:capability-inputs
npm run check:fixture-integrity
npm run test:gemini-catalog
npm run test:frontend-env
npm run test:python-workers
npm run test:frozen-css
npm run test:production-transport
npm run check:versions
npm run test:version-consistency
npm run check:tauri-contract
npm run check:visual-freeze
npm run test:visual-contract
npm run build:frontend
npm run check:frozen-css-output
npm run check:production-transport
node scripts/check-release-readiness.js --profile compile
cargo fmt --all -- --check
npm run cargo:clippy
npm run cargo:test
```

### Real-binary journeys

The gates above run against sources. These run against the shipped application through WebDriver,
which is the only layer that can observe what a user observes -- it is what found the startup font
timeout that left every clean installation unable to draw a subtitle while every source-level gate
stayed green. Windows only, and the E2E-channel binary must be built first:

```powershell
npm run build:e2e-binary
npm --prefix e2e test
npm --prefix e2e run test:damaged-font
```

`build:e2e-binary` uses the named nonshipping `e2e` Cargo profile, but it does not add another
unbounded `target` tree to the repository. It obtains leased Cargo, frontend, application, and reusable-asset lanes
from the owned cache at `%LOCALAPPDATA%\OSG-Development\cache` (28 GiB and 14 inactive days by
default). Set `OSG_DEV_CACHE_ROOT` to an explicit absolute directory to relocate the whole cache.
The manager rejects repository ancestors, drive roots, traversal, reparse points, unknown bytes and
foreign ownership markers; it prunes only complete manager-owned lanes and never adopts or deletes
an existing repository `target` directory. See
[`docs/rewrite/DEVELOPMENT_CACHE.md`](./rewrite/DEVELOPMENT_CACHE.md), or inspect it with:

```powershell
npm run cache:status
npm run cache:prune          # dry run
npm run cache:prune:apply    # owned external lanes only
```

The builder always rebuilds the frontend first, with version metadata pinned to the source commit so
an unchanged rerun does not relink only because the wall clock advanced. Each invocation builds in a
private temporary directory and atomically publishes a content-addressed immutable frontend
snapshot; it never rewrites production `src/config/version.js` or `build/`. Cargo receives that exact
snapshot only through its child-process `TAURI_CONFIG`. After Cargo completes, only
`osg-desktop.exe`, `ui-fonts/`, `workers/`, and `licenses/` cross into a second content-addressed
application publication. The harness resolves the current receipt, independently verifies its
manifest and every file digest, and holds the managed lane lease for the real process lifetime. A
concurrent, corrupt, or interrupted publisher therefore cannot expose mixed bytes or replace the
last known-good runnable app. The managed frontend and schema-v2 application publishers each retain
only the verified current hash and one verified previous hash. During the schema-v1 application
migration, at most one separately verified legacy publication may remain beside that bounded pair.
Tools, engines, deterministic media, and workflow screenshot evidence use separate leased external
lanes under the same cap; evidence is browsable under `evidence\<workflow>\attempts`. Each workflow
keeps its three newest immutable attempts plus its latest successful proof (at most four when the
success is older). Frontend publication, application publication, and evidence retention each
validate their complete publisher-owned inventory and use a recoverable journaled quarantine, so a
hard kill cannot turn a partial publish or delete into permanent cache poison.

Canonical local frontend, Cargo, and Tauri commands all enter that same manager. The inner
`apps/desktop` Tauri entry points reject unmanaged local invocations, and Vite itself fails closed
if an inner command is reached without the exact owned Cargo/frontend/application markers and one
live shared lease.

Cargo is bounded to one build job so unattended tests do not exhaust the workstation while another
Rust task is active. Desktop builds emit only the `rlib` consumed by `src/main.rs`; unused mobile ABI
static/DLL forms belong in a future thin mobile wrapper. Final binary, installer, updater, size and
installed-app proof still use the unchanged production release profile and ordinary wall-clock build
metadata.

The ordinary `cargo:check`, `cargo:test`, `cargo:clippy`, `tauri:dev`, and `tauri:build` npm commands
also hold managed dev/package leases and put both Cargo and generated frontend output in the
external cache. The inner `apps/desktop` Tauri entry points reject unmanaged local invocations;
always start them through the root npm commands. Running raw Cargo from the repository bypasses size
management and is intentionally no longer the documented local path.

`npm --prefix e2e test` runs every journey against the built application in an isolated data root.
`test:damaged-font` stages throwaway copies of that installation with damaged font resources and
checks the application degrades to a typed, actionable state rather than waiting forever. The
WebDriver server is compiled only under the `e2e-automation` feature and is absent from production.

`scripts/test-installed-windows.ps1` installs, launches, and uninstalls the real NSIS bundle; it
only runs on an isolated CI runner (`$env:CI` and `$env:RUNNER_TEMP`). To run that same decisive
journey on a developer machine instead, use `scripts/test-installed-local.ps1`: it refuses to start
unless the app-data directory, uninstall registry key, default install directory, Start Menu
shortcut, and Desktop shortcut are all independently verified absent, runs the unmodified CI script
in a sandboxed child process under the managed local cache's `staging` lane, and then uninstalls
and cleans up everything it created. `-WhatIf` prints the full planned side effects, including
whether the guard would currently allow the run, without installing, launching, or writing
anything. See [`docs/rewrite/INSTALLED_SMOKE_LOCAL.md`](./rewrite/INSTALLED_SMOKE_LOCAL.md) for
the complete side-effect catalog. Its argument-handling and dry-run behavior are covered by:

```powershell
npm run test:installed-local
```

`compile` verifies source/repository invariants. The stricter target-specific `runtime-package`
profile passes for Windows x64. Linux and macOS intentionally fail until equivalent native-tool,
model, renderer, and real-device proofs are published; bypassing it does not validate those targets.

For example, the Windows release gate is:

```powershell
node scripts/check-release-readiness.js --profile runtime-package --target x86_64-pc-windows-msvc
```

The other matrix targets are `x86_64-unknown-linux-gnu`, `aarch64-apple-darwin`, and
`x86_64-apple-darwin`.

Once an unsigned Windows installer exists (`node apps/desktop/node_modules/@tauri-apps/cli/tauri.js
bundle --ci --no-sign --target x86_64-pc-windows-msvc --bundles nsis`), inspect what it actually
ships -- the exact expected top-level shape, forbidden Electron/Node/Chromium/Python residue from the
removed stack, third-party notice coverage, and the packaged executable's version metadata:

```powershell
npm run check:installer-payload -- --installer "target\x86_64-pc-windows-msvc\release\bundle\nsis\<name>.exe"
```

It extracts the installer read-only with 7-Zip (the locked `7zip-bin-full` package) and never launches
it. Pass `--payload-dir <extracted-directory>` instead when 7-Zip is unavailable or the payload was
extracted another way. Its own contract is covered by `npm run test:installer-payload`.

## Runtime delivery status

| Runtime | Delivery status |
| --- | --- |
| yt-dlp | Reviewed `2026.07.04` direct releases are the offline baseline on four target families. The first user-initiated media action installs the complete required tool batch in parallel with cancellable aggregate progress. If an installed yt-dlp process later fails, the host performs one throttled check of yt-dlp's recommended official nightly channel and hot-activates a newer verified version without `yt-dlp -U` or an application restart. |
| Deno | Reviewed `2.9.5` content-addressed direct-upstream releases are catalogued for the four target families. URL inspection installs and activates it automatically on first use; it is never bundled or downloaded at startup. |
| FFmpeg / ffprobe | Windows x64 downloads the reviewed, hash-pinned Gyan `8.1.2` vendor archive, installs only the two executables plus license/build notice, and activates them in the running application. Linux/macOS remain fail-closed until equivalent deliveries are reviewed. |
| Parakeet / Faster-Whisper / Qwen3-ASR | Windows x64 has content-addressed runtime/model manifests and external-first model sources with the reviewed bundle pool as fallback. All five install, launch under a held lease, and remove through typed native jobs. |
| F5-TTS / Chatterbox / Edge TTS / gTTS / Gemini TTS worker | Windows x64 has verified managed runtime/model packages. Every backend is independently downloadable/removable; the three network providers use minimal 11–20 MB downloads rather than the GPU runtime. |
| Gemini voice previews | The exact 30-sample, 13.5 MB content-addressed pack installs automatically on first preview on all four target families, streams through an opaque native media capability, and removes immediately without restarting. No preview WAV is embedded in the frontend. |
| Application updater | The public key is configured and updater artifacts are signed with a private key held outside the repository. |

YouTube settings describe the native **Desktop app** OAuth client and its temporary loopback
callback; the retired browser callback is absent from the production bundle.

API-key help identifies the operating-system credential store. Legacy browser values are imported
once and scrubbed.

Windows speech delivery includes the reviewed runtime, transitive libraries, models, notices, and
offline worker proof. The optional F5TTS v1 base model is `CC-BY-NC-4.0` and must not be used for commercial work.
Arbitrary model URLs are not launchable; only reviewed content-addressed packages are accepted.

PromptDJ uses the operating-system UI font stack and no longer packages a separate proprietary
font payload. Any future bundled font must still be reviewed and recorded in
`THIRD_PARTY_NOTICES.md`.

The `manage-native-tools` capability exposes typed catalog/status/install/remove/cancel commands;
executable paths and upstream URLs stay native. Required tools install concurrently on first use,
publish under per-tool operation locks, acquire verified leases, and refresh download/media/render
consumers immediately. Installation progress uses the existing toast surface with an explicit
cancel action. Removal detaches the runtime and deletes it in the same session. An active media
operation makes removal return busy until that operation finishes; restarting is not required.
Sanitized native diagnostics are bounded to `osg.log` plus one rotated previous file in the Tauri
application log directory. On Windows the exact location is
`%LOCALAPPDATA%\io.github.nganlinh4.oneclicksubtitles\logs\osg.log`. Windows can install FFmpeg/ffprobe from the exact reviewed vendor
archive; unsupported platforms fail closed without substituting an unreviewed binary.

The executable-size and source-priority rules for every optional runtime are documented in
[`docs/rewrite/DOWNLOADABLE_PAYLOADS.md`](./rewrite/DOWNLOADABLE_PAYLOADS.md).

Development and release builds use the same checked-in remote delivery catalogs and
receipt-verified package stores. Neither build searches the source tree, adjacent binaries,
virtual environments, or system `PATH` for optional runtimes. `npm run tauri:dev` verifies the OSG
bundle-pool release read-back before starting; direct Cargo builds enforce the same local
source/catalog checkpoint. See the downloadable-payload document for the append-only publication
sequence.

## Data and migration

The native app stores projects, revisions, job state, settings, and artifact metadata in SQLite.
Credentials live in Windows Credential Manager, macOS Keychain, or Linux Secret Service; the UI
receives opaque references and safe status only.

Legacy import is an explicit, user-selected operation. It can copy bounded supported artifacts,
safe preferences, and supported credentials from an old data folder. It rejects links and changed
sources, is safe to retry, leaves the source directory untouched, and ignores transient caches,
paths, URLs, and obsolete provider handles.

In the desktop app, press `Ctrl+Alt+Shift+I` on Windows/Linux or `Command+Option+Shift+I` on macOS,
then choose the previous OSG data folder in the native picker. The app reports a path-free summary
through its existing toast panel. Restart OSG afterward to load imported settings.
