# Workspace Agent Guidance

## Development storage and cleanup

- Keep disposable OSG builds, test profiles, downloaded test media, toolchains and temporary
  worktrees inside the owned managed development cache (`%LOCALAPPDATA%\OSG-Development\cache`,
  or the configured `OSG_DEV_CACHE_ROOT`). Use its existing lane/lease/ownership APIs; do not
  create unmanaged directories inside it or bypass its ownership checks.
- Never create sibling clones, test folders or caches under `C:\WORK`. Use managed staging for
  temporary worktrees and remove them with `git worktree remove` when their task finishes.
- Use the repository's managed build commands (`npm run cargo:check`, `npm run cargo:test`,
  `npm run cargo:clippy`, `npm run tauri:dev` and the managed E2E/package scripts). Do not run
  bare Cargo builds/tests that recreate repository-local `target` directories.
- The default 28 GiB / 14 inactive-day policy covers only the managed cache, not the whole
  workspace. Check both managed-cache usage and unmanaged outputs before and after substantial
  build/test work. Run the existing cache prune command after releasing task-owned leases;
  report protected/in-use over-budget data rather than bypassing protections.
- Tests must use unique temporary directories and clean them in teardown, including failures;
  never use a fixed sibling directory such as `managed-command-test-cache`.
- Before cleanup, resolve exact paths, check process usage and Git tracked/untracked changes,
  and distinguish disposable outputs from source changes, credentials and user media. Never
  force-remove dirty worktrees, follow directory junctions during deletion, or delete other
  projects. Preserve unique work and report anything intentionally retained.
- At handoff, report leftover temporary directories and why they remain. Do not leave orphan
  worktrees or silently expand the storage budget.

## Launching the debug application

- When the user asks to launch the current debug app, run `npm run tauri:dev` from the repository
  root. Never launch `target/debug/osg-desktop.exe` directly: that binary loads the configured Vite
  development URL and displays `ERR_CONNECTION_REFUSED` without the managed dev server.
- Keep the managed Tauri command alive for as long as the user is testing. Closing its terminal
  session also closes Vite and invalidates the running WebView.
- Do not report that the app is running merely because an `osg-desktop` process exists. Verify all
  three launch receipts first:
  1. `http://127.0.0.1:3030/` returns HTTP 200.
  2. The live `osg-desktop` executable comes from the managed development cache.
  3. The newest application instance records `app.page_load_finished` in `logs/osg.log`.
- If any receipt is absent, treat the launch as failed and repair it before handing control back.
- Do not use Windows GUI automation for ordinary development launches or inspection unless the
  user explicitly authorizes it for that task.
