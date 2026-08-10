# Tauri desktop host

This directory is the Tauri 2 composition root. It hosts the canonical frontend from repository
root `src/` and `public/`; there is no second UI implementation.

Rust commands own files, projects, jobs, settings, credentials, provider traffic, media work,
rendering, and supervised optional workers. The main WebView receives only the explicit custom
permissions in `src-tauri/capabilities/main.json`.

## Development

Use the repository-pinned Node.js 24.19.0, npm 11.17.0, Python 3.12.10, Rust 1.97.1,
and Tauri CLI 2.11.4 toolchains.

From the repository root:

```powershell
npm ci
npm --prefix apps/desktop ci
npm run tauri:dev
```

Vite is started automatically by Tauri. `npm run dev:vite` is useful for frontend-only inspection,
but browser mode cannot exercise native commands and is not the product runtime.

## Compile without packaging

```powershell
npm run build:frontend
cargo check --workspace --all-features --locked
npm run tauri -- build --no-bundle --ci -- --locked
```

Do not treat `--no-bundle` as a release. Target-specific optional runtimes, notices, updater
signing, and installer validation are enforced by the stricter runtime-package gates.

## Native verification

```powershell
npm run check:dependencies
npm run lint
npm test
npm run test:python-workers
npm run build:frontend
npm run check:production-transport
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
npm run check:tauri-contract
node scripts/check-release-readiness.js --profile compile
```

The target-specific release gate takes a Rust target triple. It intentionally fails at the current
checkpoint because FFmpeg/ffprobe, ASR, speech, and Remotion deliveries are incomplete and the
updater public key is still a placeholder:

```powershell
node scripts/check-release-readiness.js --profile runtime-package --target x86_64-pc-windows-msvc
```

Do not weaken or skip that gate to produce a distributable. The repository owner must also choose
a root project license and approve the third-party-notice/corresponding-source policy; the gate
requires `THIRD_PARTY_NOTICES.md` before distribution.

Architecture and trust boundaries are documented in [../../ARCHITECTURE.md](../../ARCHITECTURE.md)
and [../../SECURITY.md](../../SECURITY.md).
