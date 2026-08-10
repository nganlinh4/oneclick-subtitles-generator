# Visual freeze

The Tauri/Rust rewrite has no visual-design mandate. Any intentional visual difference from the
existing OSG application is a regression unless the user separately approves it.

## Canonical frontend

- Repository-root `src/` and `public/` are the only frontend source of truth.
- The Tauri host uses the existing Vite development server and production build directly.
- Do not duplicate, reinterpret, restyle, or gradually approximate the current interface.
- Keep the exact markup, CSS, assets, fonts, themes, locales, vocabulary, responsive behavior,
  animation, and workflow ordering.
- New native capabilities enter through compatibility adapters behind existing interactions.
- Architecture diagnostics and migration status never appear in the product UI.

## Rewrite boundary

Rust replaces Electron, Express, fixed ports, persistence, media processing, model clients,
rendering, and worker supervision. Those changes remain behind the existing UI contract until a
separately approved product-design change exists.

When an old interaction cannot work yet, retain its existing appearance and document the missing
backend capability outside the UI. Do not invent a replacement screen or temporary visual system.

## Verification

Run the provenance-backed frontend, PromptDJ, and Remotion visual contracts from the repository
root:

```powershell
npm run check:visual-freeze
npm run test:visual-contract
```

The baselines derive from the approved original source. Do not regenerate them to make an
architectural rewrite pass. An approved visual product change must update the relevant baseline in
a separate, explicitly reviewed change.
