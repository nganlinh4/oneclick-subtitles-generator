# Tauri desktop host

The Tauri 2 composition root. It serves the frontend from the repository root (`src/`, `public/`);
there is no second UI. The main WebView gets only the permissions listed in
`src-tauri/capabilities/main.json`.

Run everything from the repository root through the npm scripts (`npm run tauri:dev`,
`npm run tauri:build`, `npm run cargo:test`). The scripts in this package refuse to run outside the
managed build lease. See [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md) for setup and checks,
[ARCHITECTURE.md](../../ARCHITECTURE.md) and [SECURITY.md](../../SECURITY.md) for the boundaries.

A `--no-bundle` build is not a release; releases follow
[docs/release/RELEASING.md](../../docs/release/RELEASING.md).
