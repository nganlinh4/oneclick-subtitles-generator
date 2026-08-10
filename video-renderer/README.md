# Subtitled Video Maker

<div align="center">
  <img src="readme_assets/Screenshot%202025-03-26%20105427.png" width="400" />
  <img src="readme_assets/Screenshot%202025-03-26%20105510.png" width="400" />
  <img src="readme_assets/Screenshot%202025-03-26%20105612.png" width="400" />
  <img src="readme_assets/Screenshot%202025-03-26%20105618.png" width="400" />
  <img src="readme_assets/Screenshot%202025-03-26%20105623.png" width="400" />
  <img src="readme_assets/Screenshot%202025-03-26%20105642.png" width="400" />
</div>

This workspace contains OSG's frozen Remotion composition and native stdio render worker. It is
not a standalone web application or HTTP server.

The Tauri host resolves opaque project/media/speech artifact IDs, prepares a bounded render job,
and supervises `worker/osg_render_worker.mjs`. The worker receives framed requests over private
stdin/stdout and writes only to native-selected staging paths. The former Express upload/render
service is not part of the native architecture.

## Visual contract

The composition preserves the original subtitle styling, fonts, effects, animation, layout, and
audio behavior. Changes to `src/` or the render bundle must pass the provenance-backed visual
contract rather than updating the baseline as part of an unrelated rewrite.

```powershell
npm run --workspace=video-renderer check:visual-contract
npm run --workspace=video-renderer check:visual-provenance
```

## Development commands

Run these from the repository root after `npm ci`:

```powershell
npm run --workspace=video-renderer native:typecheck
npm run --workspace=video-renderer native:bundle
npm run --workspace=video-renderer test:worker
```

The generated native bundle is a build artifact; edit the TypeScript source instead.

## Packaging status

The worker and delivery schema are implemented, but all target-specific Remotion runtime release
lists are intentionally empty. A distributable renderer still needs reviewed Node, Chromium,
Remotion, native binaries, and font payloads with exact hashes and notices for Windows x64, Linux
x64, macOS Intel, and macOS Apple Silicon. Source-level worker tests do not make those runtime
packages installable.

See [../ARCHITECTURE.md](../ARCHITECTURE.md#runtime-delivery) for the application boundary.
