# Running the installed smoke locally

`scripts/test-installed-windows.ps1` is the installed-application journey: install the real NSIS
bundle, launch, relaunch, uninstall and reinstall `osg-desktop.exe`, and drive it over its debug port
through native pickers, tool installation, media download and editing. It refuses to run unless
`CI=true` and `RUNNER_TEMP` are set, because it was written for a disposable runner.

`scripts/test-installed-local.ps1` runs that unmodified script on a developer machine. It spawns it
as a child process with `CI` and `RUNNER_TEMP` set only in that child's environment, and adds the
guards and cleanup a persistent machine needs. `-WhatIf` prints the plan, including whether the
guard would allow a run, without installing anything. `npm run test:installed-local` tests the
wrapper.

## What the installer touches

These paths are fixed by the production build and the product name, so they cannot be relocated
without testing a different binary:

| Surface | Path |
| --- | --- |
| App data, cache, logs | `%LOCALAPPDATA%\io.github.nganlinh4.oneclicksubtitles` |
| Install directory | `%LOCALAPPDATA%\One-Click Subtitles Generator` (NSIS per-user default, `/S`, no `/D`) |
| Uninstall key | `HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\One-Click Subtitles Generator` |
| Shortcuts | `One-Click Subtitles Generator.lnk` in the Start Menu and on the Desktop |

`OSG_E2E_DATA_ROOT` only exists in the test channels and only moves the data directories, and
`/D=` only moves the binaries; the registry key and shortcuts would still collide with a real
install. A separate account or Windows Sandbox needs admin rights or Windows Pro.

## Why it refuses to start

The wrapper isolates by time instead of by path: it refuses to start unless all five surfaces
above are absent. If you have OSG installed, uninstall it (and move its data folder aside) first.
After the run, pass or fail, it uninstalls, deletes the app-data directory it created, removes
shortcut residue, and fails loudly if anything is left.

Everything relocatable (screenshots, JSON results, fixtures, inspector logs) goes into a leased run
folder under the managed cache: `%LOCALAPPDATA%\OSG-Development\cache\staging\installed-smoke\<runId>\`.
The CI script itself never uninstalls at the end; on a runner the VM is thrown away.
