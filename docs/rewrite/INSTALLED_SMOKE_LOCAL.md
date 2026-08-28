# Running the installed-EXE smoke locally

[`scripts/test-installed-windows.ps1`](../../scripts/test-installed-windows.ps1) is the decisive
installed-application journey: install the real NSIS bundle, launch/relaunch/reinstall the real
`osg-desktop.exe`, drive it over its own remote-debugging port, and prove native pickers, native
tool installation, media download, and diagnostic log rotation all work from the shipped binary
rather than from source. It refuses to run unless `$env:CI -eq 'true'` and `$env:RUNNER_TEMP` is
set, because every side effect below was designed for an ephemeral GitHub Actions runner that is
destroyed after the job, not for a developer's own Windows profile.

[`scripts/test-installed-local.ps1`](../../scripts/test-installed-local.ps1) makes the same journey
honestly runnable on a developer machine: a bounded local sandbox, the same collision guard CI relies
on extended to every surface a persistent machine actually has, and cleanup that CI never needed.
**It does not fork the CI script's logic.** It spawns the unmodified
`scripts/test-installed-windows.ps1` as a real child process with `CI`/`RUNNER_TEMP` set only on
that child's environment block, then adds pre-flight and post-run steps around it. The CI entry
point (`./scripts/test-installed-windows.ps1 ...` invoked directly by the workflow) is unmodified —
byte-identical to before this change.

## Complete side-effect catalog (as of the reviewed script)

Evidence is cited as `file:line` against this worktree.

### Process/installer invocation

- Installer run silently: `Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru`
  (`scripts/test-installed-windows.ps1:90`). No `/D=` override is used today, so NSIS uses its
  built-in default per-user install directory.
- Uninstaller run silently the same way, resolved only from the validated install root's
  `uninstall.exe`: `scripts/test-installed-windows.ps1:3006-3018`.
- The application binary itself is launched directly (not through the installer) with
  `Start-Process -FilePath $Executable -PassThru` after temporarily exporting
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<free loopback port>` on the
  *calling* process's environment for the duration of the `Start-Process` call, then removing it
  (`scripts/test-installed-windows.ps1:2897-2906`). This happens on **first launch, relaunch, and
  reinstall-launch** (three full app lifecycles: `scripts/test-installed-windows.ps1:3034-3070`).
- `Inspect-InstalledNativeTools` spawns a `node` child process running
  `scripts/inspect-installed-native-tools.mjs`, redirected to stdout/stderr files under
  `$env:RUNNER_TEMP`, with a 31-minute wait (`scripts/test-installed-windows.ps1:408-419`) — this is
  the real native-tool download/install/remove/reinstall cycle (deno, media-tools, yt-dlp).
- Every `Inspect-Installed*` helper (`WebView`, `MediaFlow`, `LocalMediaFlow`, `MediaPipeline`,
  `EditorFlow`) spawns a `node scripts/inspect-installed-*.mjs` child that connects to the app's
  Chrome DevTools Protocol debug port; all of them write only to caller-supplied paths under
  `$env:RUNNER_TEMP` (verified: no `os.tmpdir()`/stray-path writes in any `inspect-installed-*.mjs`).
- Graceful close is a native `WM_CLOSE` via `Process.CloseMainWindow()`, with a 30s timeout before a
  hard `Stop-Process` fallback (`scripts/test-installed-windows.ps1:233-262`).
- A `Dismiss-NativeMediaPicker` UI-Automation/Win32 path (`scripts/test-installed-windows.ps1:510+`,
  dot-sourcing `scripts/native-picker-evidence.ps1`) enumerates **all top-level windows on the
  desktop** (`EnumWindows`) to find the native "Choose video or audio" common dialog owned by the
  app's main window, and can post it a close message. It never creates windows itself; it only reads
  window classes/titles/owners and can `PostMessage(WM_CLOSE)` to one exact, validated match.

### Filesystem — installer/app footprint (NOT sandboxed by `RUNNER_TEMP`)

- **Install root**: NSIS's per-user default (currentUser install mode; confirmed by the `HKCU`
  uninstall key below — Tauri v2 NSIS default `installMode` is `currentUser`, and
  `apps/desktop/src-tauri/tauri.conf.json:86-90` does not override it). Verified empirically on this
  machine's own real install: `%LOCALAPPDATA%\One-Click Subtitles Generator` (i.e.
  `<InstallLocation>` from the live registry key below) — **not** `%LOCALAPPDATA%\Programs\...`.
  `scripts/test-installed-windows.ps1:100-108` only asserts the resolved `InstallLocation` stays
  under `%LOCALAPPDATA%`; it does not pin the exact leaf.
- **App data / cache / logs**: `%LOCALAPPDATA%\io.github.nganlinh4.oneclicksubtitles` — this is the
  Tauri `app_local_data_dir()`/`app_cache_dir()`/`app_log_dir()` resolution for identifier
  `io.github.nganlinh4.oneclicksubtitles` (`apps/desktop/src-tauri/tauri.conf.json:5`), and
  `scripts/test-installed-windows.ps1:82-87` computes the identical path as its `$profileRoot`
  pre-flight guard. Under it: `logs\osg.log` (`:3032`), `ui-fonts\v1` (`:3033`), plus (per
  `apps/desktop/src-tauri/src/lib.rs:482-535`, not directly asserted by the CI script but real)
  `db/osg.sqlite3`, `engine-packages/v1`, `asset-packages/v1`, `native-tools/v1`.
- **Registry**: one value, `HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\One-Click
  Subtitles Generator` (`scripts/test-installed-windows.ps1:117`), holding `DisplayVersion`,
  `InstallLocation`, `UninstallString`, `DisplayIcon`, `EstimatedSize`, etc. No `HKLM` writes (no
  admin rights required); no `Run` keys, scheduled tasks, services, or firewall rules anywhere in
  the script (grepped for `HKLM`, `schtasks`, `netsh`, `New-ItemProperty`, `reg.exe`, `Task
  Scheduler` — zero matches).
- **Shortcuts**: not asserted by the CI script at all (no `Shortcut`/`.lnk` reference anywhere in
  `scripts/test-installed-windows.ps1`). Tauri's NSIS bundler template creates them outside this
  repo's source, so this lane cannot cite a first-party `file:line` for their existence — but they
  are real and were confirmed directly against this exact machine's own install (see verdict below):
  a Start Menu shortcut and a Desktop shortcut, both named `One-Click Subtitles Generator.lnk`.
- `installer-hooks.nsh` (`apps/desktop/src-tauri/installer-hooks.nsh`) additionally deletes one named
  legacy file (`workers\osg_render_worker.mjs`) pre-install and post-uninstall, and removes
  `$INSTDIR\workers` and `$INSTDIR` themselves only if empty. No other paths are touched.

### Filesystem — evidence/scratch (fully contained under `RUNNER_TEMP`)

Every screenshot, JSON result, native-picker evidence file, SRT fixture, and inspector
stdout/stderr log is written under `$env:RUNNER_TEMP`, and the script asserts each target path is
"clean" (absent) before writing and stays inside `$env:RUNNER_TEMP` (e.g.
`scripts/test-installed-windows.ps1:26-52`, `:2629-2668`, `:2801-2846`). Nothing here touches a
fixed OS path.

### Lifecycle note: the CI script never uninstalls at the end

`scripts/test-installed-windows.ps1` installs, launches, closes, relaunches (proving diagnostic
rotation), **uninstalls, reinstalls** (`:3059-3061`, proving the reinstall matches byte-for-byte and
that cached UI fonts/registry survive), runs the optional media/native-tool/editor flows, and then
only calls `Stop-Application` (`:3261`) — **the final "reinstalled" copy, its registry key, and its
app-data directory are left installed** when the script returns success. On an ephemeral CI runner
this is fine (the VM is discarded). On a developer machine it is not: the local wrapper adds the
final uninstall + residue verification this script intentionally omits.

## Data-dir collision verdict — real, evidenced, and *currently present on this machine*

`apps/desktop/src-tauri/src/lib.rs:1076-1105`:

```rust
/// This exists ONLY in the two test-only channels. There is no `cfg` in this function that a
/// production build compiles...
#[cfg(any(feature = "unsigned-local-build", feature = "e2e-automation"))]
pub(crate) fn harness_data_root() -> Option<std::path::PathBuf> {
    let raw = std::env::var_os("OSG_E2E_DATA_ROOT")?;
    ...
}

#[cfg(not(any(feature = "unsigned-local-build", feature = "e2e-automation")))]
pub(crate) const fn harness_data_root() -> Option<std::path::PathBuf> { None }
```

`setup_app` (`apps/desktop/src-tauri/src/lib.rs:446-459`) only consults `harness_data_root()`; when
it is `None` (every `production`-feature build — see
`apps/desktop/src-tauri/Cargo.toml:19-28`, and the two `tauri build`/`bundle` invocations that
produce the exact installer this script tests, `rewrite-ci.yml:349,352` and
`updater-smoke.yml:87,90`, both pass `--features production[,ci-updater-fixture]`, never
`unsigned-local-build`) it falls back unconditionally to
`app.path().app_local_data_dir()`/`app_cache_dir()`/`app_log_dir()`. **There is no environment or
CLI override reachable in this build.** The comment at `lib.rs:1078-1081` further records that
spoofing `%LOCALAPPDATA%` itself does not work on Windows: `app_local_data_dir()` resolves through
`SHGetKnownFolderPath`, which ignores a process-scoped `%LOCALAPPDATA%` override.

That fixed path is `%LOCALAPPDATA%\io.github.nganlinh4.oneclicksubtitles`
(`tauri.conf.json:5`) — and it, the matching registry key, and both shortcuts **already exist on
this exact developer machine**, confirmed by direct read-only inspection while designing this lane:

| Surface | Path | State |
|---|---|---|
| App data root | `C:\Users\user\AppData\Local\io.github.nganlinh4.oneclicksubtitles` | **exists** |
| Uninstall registry key | `HKCU:\...\Uninstall\One-Click Subtitles Generator` | **exists** (`DisplayVersion 1.0.0`, `InstallLocation "C:\Users\user\AppData\Local\One-Click Subtitles Generator"`) |
| Default install dir | `C:\Users\user\AppData\Local\One-Click Subtitles Generator` | **exists** (real dogfood build) |
| Start Menu shortcut | `...\Start Menu\Programs\One-Click Subtitles Generator.lnk` | **exists** |
| Desktop shortcut | `C:\Users\user\Desktop\One-Click Subtitles Generator.lnk` | **exists** |

This is exactly the CI script's own guard condition
(`if (Test-Path -LiteralPath $profileRoot) { throw "CI profile is not clean: $profileRoot" } `,
`scripts/test-installed-windows.ps1:85-87`) already failing on this machine today, for the one
surface it checks. The local wrapper extends that same refuse-unless-absent guard to all five
surfaces above and does not weaken it.

### Options considered for isolating the app-data path, and why the guard (not relocation) was chosen

1. **`OSG_E2E_DATA_ROOT` via the `unsigned-local-build`/`e2e-automation` Cargo feature.** This *is*
   a genuine override — it exists for precisely this purpose (`lib.rs:1080-1081`: "a harness that
   must not touch a developer's projects needs the application to accept a root"). But it only
   redirects the three Tauri data directories. It does **nothing** for the other four surfaces:
   the registry uninstall key name, the default install directory name, and both shortcut names are
   all derived from `productName` in `tauri.conf.json:3` at NSIS-bundling time, not from a Rust
   `cfg` feature or a runtime environment variable — no per-user silent-install flag changes them.
   Redirecting only the data directory while the installer still writes the *same* registry key
   name would overwrite the real key's `InstallLocation`/`DisplayVersion` mid-run and then delete it
   on cleanup, which is worse than not isolating at all. Using this override would also mean testing
   a materially different binary (`unsigned-local-build`/`e2e-automation`) than the one CI's
   `windows-installed-branch-smoke`/`windows-published-installed-smoke` jobs actually exercise
   (`production`-feature, code-unsigned only via `--no-sign`) — a second, silent behavior fork this
   lane was explicitly told to avoid.
2. **NSIS `/D=` to relocate the install directory only.** Genuinely available (`Install-Application`
   already isolates a `/S`-only call at `scripts/test-installed-windows.ps1:90`; adding an optional
   `/D=` is additive and backward compatible). It moves the *binaries*, but the registry key name,
   Start Menu folder, and Desktop shortcut name are unaffected — same problem as option 1's residual
   collision, just smaller. Not sufficient on its own.
3. **A separate Windows account / Windows Sandbox / VM.** Would isolate everything, including the
   registry hive and Desktop. Rejected: creating a new local Windows account requires administrator
   rights (`New-LocalUser`/`net user /add`); Windows Sandbox requires Windows 10/11 **Pro or
   Enterprise** and is unavailable on this machine's actual edition (Windows 11 **Home**, per the
   environment this lane observed). Both fail the "requires no admin rights" constraint outright, one
   of them unconditionally on this exact machine.
4. **Refuse-unless-verified-absent + guaranteed post-run cleanup (chosen).** Isolate what can
   actually be relocated without admin rights or a build fork (all `RUNNER_TEMP`-equivalent evidence,
   screenshots, fixtures — real path isolation, held under the repo's existing managed
   `%LOCALAPPDATA%\OSG-Development\cache` staging lane, see below). For the four surfaces that
   cannot be safely relocated (app data, registry key, install dir, shortcuts), isolate by **time**
   instead of by **path**: refuse to start unless every one of them is independently verified absent,
   and after the run — success or failure — uninstall, delete the now-known-ours app-data directory,
   remove any shortcut residue, and fail loudly if anything survives. This requires no admin rights,
   never diverges from the exact binary CI tests, and never silently narrows the safety check CI
   already relies on.

## Local sandbox layout

The wrapper places every relocatable artifact under this repository's existing owned local cache
(`scripts/dev-cache.ps1`, documented in [`DEVELOPMENT_CACHE.md`](DEVELOPMENT_CACHE.md)), using its
`staging` lane exactly as the mission and the lane's own doc describe ("Evidence and staging accept
bounded, directory-shaped runs"):

```
%LOCALAPPDATA%\OSG-Development\cache\staging\installed-smoke\<runId>\
```

`<runId>` is a timestamp+random leaf so concurrent local runs never collide. The wrapper:

1. Runs `dev-cache.ps1 -Action Prune -Apply -ProtectUnit apps-e2e` (best-effort, mirrors
   `e2e/support/stagingLease.js:89-97`), then acquires a process-held `staging` lease
   (`dev-cache.ps1 -Action Lease -LeaseOperation Acquire -Lane staging -LeaseProcessId $PID`) so a
   concurrent prune from another command cannot reclaim the sandbox mid-run.
2. Creates `installed-smoke\<runId>` inside the leased `stagingRoot` and uses it as `RUNNER_TEMP`
   for the child invocation — the same directory the CI script already writes every screenshot,
   JSON result, SRT fixture, and native-picker evidence file into.
3. If `-LocalMediaPath` is given, copies the reviewed fixture into the sandbox first (the CI script
   requires `-LocalMediaPath` to already live under `RUNNER_TEMP`; a fresh per-run sandbox can't be
   known in advance, so the wrapper does the containment copy instead of asking the caller to guess
   a not-yet-created path).
4. Spawns `pwsh -NoProfile -NonInteractive -File scripts/test-installed-windows.ps1 <forwarded args>`
   as a real OS child process (`System.Diagnostics.Process`, not `&`/dot-source) with a
   **process-local** environment block: a copy of the current environment with `CI=true` and
   `RUNNER_TEMP=<sandbox>` added only on that `ProcessStartInfo`. This is the "scoped to the child
   process only" requirement: setting `$env:CI`/`$env:RUNNER_TEMP` on the *wrapper's own* PowerShell
   process would leak into the caller's interactive session if this script is ever dot-sourced, and
   would misrepresent the isolation contract as "we are CI" rather than "we are asserting the same
   contract CI asserts, locally, on purpose." The wrapper never claims `$env:CI` for itself.
5. In `finally`, regardless of outcome: silently uninstalls (if a registry key/executable from this
   run is still present), deletes the app-data directory this run created (only ever the one proven
   absent by the pre-flight guard), verifies no shortcut/registry/install-dir residue remains,
   releases the staging lease, deletes the sandbox directory tree, and prunes again. Any surviving
   residue is reported as a failure (nonzero exit), even if the inner CI script itself reported
   success.

## `-WhatIf`

`scripts/test-installed-local.ps1` is `[CmdletBinding(SupportsShouldProcess)]`. Under `-WhatIf` it
performs only read-only checks (the same `Test-Path`/registry existence checks the live guard would
run) and prints the full planned side-effect list — installer flags, resolved sandbox path, the five
guarded real-machine surfaces and their current state, and whether the guard would currently allow
the run to proceed — then exits without creating the sandbox, touching the registry, or spawning any
process.

## Tests

`scripts/test-installed-local.test.ps1` follows the existing hand-rolled harness pattern
(`scripts/dev-cache.test.ps1`, run via `npm run test:dev-cache`) rather than Pester — that is the
only convention this repository already has for testing a `.ps1` script. It covers argument
validation, `-WhatIf` output content and non-mutation, and the guard logic against synthetic
override paths (never the real `%LOCALAPPDATA%` surfaces) via the same kind of explicit
`-CacheRoot`-style relocation parameter `dev-cache.ps1` already exposes publicly. Run it with:

```powershell
npm run test:installed-local
```

It never runs the installer, spawns the app, or touches this machine's real profile, registry, or
Desktop.
