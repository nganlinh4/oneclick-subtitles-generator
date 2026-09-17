# Approved UI baseline

The canonical product is the current native branch, not legacy `main`. On 2026-09-17 the owner
confirmed that the visual improvements made during development are intentional and approved.
Preserve its Material 3 Expressive styling and interactions; do not restore obsolete UI just to
match the original port baseline or introduce an unrelated redesign during backend work.

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

Run the provenance-backed frontend and PromptDJ visual contracts from the repository root:

```powershell
npm run check:visual-freeze
npm run test:visual-contract
```

Baselines protect the approved current UI. Update the affected baseline with an intentional visual
change and its screenshot evidence; do not use a blanket regeneration to conceal regressions.
The compiled CSS pin records the approved September candidate at `28b2495b`. The September 15
audit documents the repaired dropdown positioning, scaling, canvas bounds and modal footers.
Source hashes and CSS inventories detect changes, not usability: real-app screenshots and
workflow results remain necessary. No comparison to legacy main is required for approved changes.
