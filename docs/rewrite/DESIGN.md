# UI design policy

The canonical product is the current native branch, not legacy `main`. Its design language is
Material 3 Expressive (M3E), ported from the Android Compose Material3 sources. The owner is
centralizing that work into shared components and revamping inconsistent screens on top of them.

## Canonical frontend

- Repository-root `src/` and `public/` are the only frontend source of truth.
- The Tauri host uses the existing Vite development server and production build directly.
- Visual changes are intentional, owner-directed work: build them from the shared M3E components
  and tokens rather than adding one-off styles, and never as a side effect of backend work.
- New native capabilities enter through compatibility adapters behind existing interactions.
- Architecture diagnostics and migration status never appear in the product UI.

## Rewrite boundary

Rust replaces Electron, Express, fixed ports, persistence, media processing, model clients,
rendering, and worker supervision. Those changes stay behind the existing UI; a backend change
must not restyle or reorder the interface.

When an old interaction cannot work yet, retain its existing appearance and document the missing
backend capability outside the UI. Do not invent a replacement screen or temporary visual system.

## Verification

Source hashes and frozen compiled-CSS pins have been retired: they detected change, not usability,
and blocked the M3E revamp. Verify visual work with focused component tests and real-app
screenshots of the affected workflows.
