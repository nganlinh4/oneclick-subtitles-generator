# Downloadable payload architecture

The Windows desktop executable is the primary distribution target. The application shell must
contain only code and assets required to open a visually stable editor. Executables, ML runtimes,
models, renderer payloads, and optional media belong in the managed package store.

## Source priority

Every catalog applies this order. A lower tier is allowed only when the higher tier cannot provide
the exact required bytes.

1. **Reviewed external publisher** — immutable or version-addressed HTTPS artifact from the tool,
   model, or runtime publisher. OSG downloads it directly and pins byte length, SHA-256, archive
   inventory, installed-file hashes, license, and source revision.
2. **OSG append-only multi-bundle release** — a content-addressed asset under an immutable release
   tag. This is for composite Python environments, OSG workers, deterministic renderer bundles, or
   cross-platform builds that no publisher ships. The release asset name contains the archive hash.
3. **Embedded application resource** — permitted only for the small protocol bootstrap workers that
   cannot execute without a separately verified managed runtime. Native executables, interpreters,
   models, browser engines, and voice packs are forbidden here.

No tier may silently fall back to `PATH`, a package manager, `pip`, `npm`, a mutable `latest` URL, or
an unverified file already on disk. Mirrors must deliver the same reviewed component identity; a
hash mismatch never becomes an implicit update.

## Current payload decisions

| Payload | Delivery | Activation | EXE impact |
| --- | --- | --- | --- |
| yt-dlp 2026.07.04 baseline + immutable newer stable releases | Direct official GitHub release on four targets; failure-triggered checks require an immutable stable release, GitHub asset digest, exact tag commit, and exact notices | A newer version is published beside the leased binary and activates after restart; the failed operation is never automatically looped | Catalog and recovery metadata only |
| Deno 2.9.5 | Direct official GitHub release on four targets | After restart, with a held tool lease | Catalog metadata only |
| FFmpeg/ffprobe 8.1.2, Windows x64 | Direct fixed Gyan vendor ZIP; selective extraction of two executables plus license/build notice | After restart, with a held media-tool lease | Catalog metadata only |
| FFmpeg/ffprobe, Linux/macOS | Disabled until reviewed direct artifacts exist; otherwise build a provenance-complete OSG mirror bundle | Not available | None |
| ASR engines | Split future packages into a shared per-platform runtime bundle plus direct, revision-pinned model files where publishers provide them | Package lease retained by worker | Worker bootstrap only |
| Speech engines | Shared per-platform Python/wheel runtime bundle; direct pinned model files where licensing permits; backend-specific overlays | Package lease retained by worker | Worker bootstrap only |
| Remotion renderer | Direct official Node and Chrome-for-Testing components, exact npm renderer/binary closure, offline font pack, and an OSG composition bundle | Managed render-runtime lease | Worker bootstrap only |
| Gemini voice samples | Keep embedded until the same 30 exact samples are published as a verified optional pack; then remove them atomically from `public/` | Download on first preview | Temporary 15.6 MiB shell cost |
| Google Sans Flex | Keep as the one identity-critical UI font until a pixel-reviewed replacement is approved | Immediate | 4.6 MiB shell cost |

The final two rows are intentionally not deleted early: doing so would report a smaller package by
breaking voice preview or changing the approved application typography. Their removal requires a
working package source and the same visual/behavior gates as the rest of the editor.

## Package construction rules

- Model files should use publisher URLs pinned to a full repository commit, following the toolbox
  model catalog pattern. Do not wrap an unchanged publisher model in an OSG archive.
- Python runtimes and dependency closures are composite products: build once per target from a
  checked lock, generate a complete file inventory and notices, then publish a content-addressed OSG
  bundle. Models remain separate so two engines can share the runtime and updates do not redownload
  unchanged weights.
- Remotion is three layers: official Node, official Chrome for Testing, and the exact OSG
  renderer/composition/font closure. Each layer gets an independent receipt so updating the project
  bundle does not redownload Chromium.
- Installation stages outside the active version, verifies the outer artifact and every selected
  installed file, publishes atomically, and records a receipt. Removal is deferred while a lease is
  live. Cancellation never exposes a partial active version.
- The frontend receives catalog/status/progress and opaque job IDs only. URLs, paths, and executable
  handles stay in Rust.
- yt-dlp recovery is host-managed rather than `yt-dlp -U`. Only a native process failure starts a
  coalesced check, repeated checks are throttled, invalid input/cancellation/network errors do not
  trigger it, and an unavailable update service preserves the installed version and original error.
- The native host caches update lookups for 30 minutes. It retains two verified dynamic releases
  for rollback, retires older exact trees only during lease-free startup, and quarantines modified
  trees intact before repairing them into fresh version directories.
- The toolbox release is a useful packaging example but its `sgt-runtime-bundles` tag currently
  reports `immutable: false`. OSG self-hosted fallbacks therefore use new append-only versioned
  release tags and content-addressed asset names; the mutable rolling tag is not a trust root.

## Size gate

Release CI runs `check-desktop-payload-size.mjs`. It reports the executable, frontend resource total,
and every embedded file over 256 KiB; caps the compiled frontend at 30 MiB, the measured Windows
executable at 16 MiB, and unmeasured Linux/macOS executables at 48 MiB; and fails if a native
executable, interpreter, model, Chromium/Node payload, or unreviewed
Tauri resource appears. The current 30-voice preview set is the one temporary frontend exception: its
exact files remain frozen by the visual contract and the aggregate frontend cap prevents growth until
a real verified voice-pack release exists. A size decrease is accepted only when the corresponding
feature remains reachable through a verified package flow.

The Rust desktop shell itself uses one codegen unit, full LTO, `opt-level = "z"`, aborting panics, and
symbol stripping. CPU-heavy media, model, and render work executes in managed child runtimes, so the
shell is optimized for distribution size rather than duplicating throughput-oriented native code.
