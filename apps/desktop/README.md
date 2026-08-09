# Tauri desktop host

This directory contains only the new native Tauri/Rust host. It deliberately does not contain a
second frontend implementation.

During the rewrite, the existing OSG frontend at the repository root (`src/` and `public/`) remains
the single visual source of truth. Tauri serves its normal CRA development server and embeds its
normal production build without changing markup, CSS, assets, fonts, locales, or interaction
design.

## Development

```powershell
npm run tauri:dev --prefix apps/desktop
```

## Build

```powershell
npm run tauri:build --prefix apps/desktop -- --no-bundle
```

Rust workspace checks run from the repository root:

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

The next migration boundary is a compatibility bridge that routes existing frontend operations
into typed Rust commands. Visual changes are outside the rewrite's scope.
