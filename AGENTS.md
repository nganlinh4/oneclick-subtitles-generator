# Agent guidance

One-Click Subtitles Generator (OSG) is a local-first Tauri 2 / Rust desktop app with a React
WebView. Windows x64 is the shipped target. Read [ARCHITECTURE.md](ARCHITECTURE.md) and
[SECURITY.md](SECURITY.md) before changing a runtime boundary.

## Boundaries

- The React frontend (`src/`) is the visual source of truth. Don't restyle it during other work;
  visual changes are small and previewed with the owner first.
- Rust owns projects, jobs, settings, credentials, files, provider traffic, media, downloads,
  rendering, and worker supervision. The WebView calls typed commands with opaque IDs only:
  no native paths, secrets, process arguments, or provider-private URLs cross into it.
- No browser fallbacks for native operations, and no Electron/Express/fixed-port server stack.
- Optional tools and models come only from reviewed, content-addressed delivery catalogs. Never
  fall back to a system executable or an unverified download to make a feature look installed.
- Never interpolate user input into a shell or generated source. Workers use fixed programs,
  closed arguments, allowlisted environments, and owned process-tree termination.
- Logs stay quiet and never carry private content or credentials.

## Code

- No code file over 600 lines; split along real seams. Prune dead code as you touch an area.
- One shared helper per job; don't add a parallel implementation.
- Behaviour changes come with focused tests. Run the gates in
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#verification) before committing.
- Remove a check or rule that only pins old source text or blocks without protecting anything.

## Builds and disk

- Use the managed commands (`npm run cargo:*`, `npm run tauri:dev`, the managed build/E2E
  scripts). They keep outputs in the managed cache (`%LOCALAPPDATA%\OSG-Development\cache` or
  `OSG_DEV_CACHE_ROOT`); don't create caches, clones, or test folders under `C:\WORK`.
- To launch the debug app, run `npm run tauri:dev` and keep it alive while the owner tests. It is
  only running once `http://127.0.0.1:3030/` answers and `logs/osg.log` records
  `app.page_load_finished` for the newest instance.
- Tests use unique temp directories and clean them up, including on failure.
- Before deleting anything, resolve exact paths and check for running processes and uncommitted
  work. Never follow directory junctions while deleting.

## Releases

- Releases are signed; the updater reads the feed on the `app-update-feed` branch.
  [docs/release/RELEASING.md](docs/release/RELEASING.md) has the steps. NSIS updates are not
  transactional, so a half-applied update is fixed by reinstalling.
- The project is MIT; extend `THIRD_PARTY_NOTICES.md` for anything new that ships.

## Git

Conventional commits. Never commit or push without the owner's approval for that change set.
