# Contributor guidance

One-Click Subtitles Generator is being completed as a local-first Tauri 2/Rust desktop
application. Read [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), and
[docs/rewrite/DESIGN.md](docs/rewrite/DESIGN.md) before changing a runtime boundary.

## Product boundary

- The repository-root React frontend is the only visual source of truth. Do not restyle, replace,
  or approximate it during backend work.
- The former Electron, Express, Flask, FastAPI, fixed-port, CORS, and browser-owned process stack
  has been removed. Do not recreate it or add browser fallbacks for native operations.
- Rust owns projects, jobs, settings, filesystem capabilities, provider traffic, credentials,
  media operations, downloads, rendering, and optional-worker supervision.
- The WebView uses typed commands and opaque IDs. Do not expose native paths, secrets, process
  arguments, provider-private URLs, or unrestricted filesystem/shell access.

## Runtime and release rules

- Optional tools and model runtimes come only from reviewed, target-specific, content-addressed
  delivery catalogs with immutable sources, exact hashes/sizes, inventories, and notices.
- Empty catalogs are deliberate blockers. Never make a feature appear installed by falling back to
  an arbitrary system executable or an unverified download.
- Source compilation and runtime-package readiness are separate gates. A `--no-bundle` build is not
  a distributable release.
- The updater remains disabled until the owner supplies the production signing public key and
  secures the corresponding private key.
- The owner must select a root project license and notice policy before distribution; do not infer
  one from dependency or crate metadata.

## Engineering expectations

- Refactor aggressively when a boundary is touched, but preserve unrelated work in the shared
  tree and keep behavior changes covered by focused tests.
- Prefer small typed modules, bounded inputs/outputs, explicit cancellation, no-clobber writes,
  path-safe errors, redacted diagnostics, and owned process-tree termination.
- Never interpolate user input into a shell or generated source. Native workers use fixed programs,
  closed arguments, allowlisted environments, and private framed stdin/stdout.
- Keep ordinary output quiet and actionable. Private content and credentials never belong in logs.
- Run the applicable commands in [README.md](README.md#verification), including visual, command
  contract, frontend, Rust, and readiness gates.

Use conventional commit messages. Never commit or push without explicit user approval for the
current change set.
