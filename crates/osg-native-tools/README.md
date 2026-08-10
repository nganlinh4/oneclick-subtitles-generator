# OSG native tools

This crate manages optional native command-line tools without exposing URLs,
filesystem paths, manifests, or process arguments to the WebView.

- `yt-dlp` 2026.07.04 and Deno 2.9.5 are downloaded directly from immutable
  upstream release URLs and verified by exact size and SHA-256 before use.
- Upstream license and third-party-notice files are fetched from exact commit
  revisions and become part of the verified installed tree.
- The managed `yt-dlp` binary never mutates itself. After a real yt-dlp process
  failure, the host may query the official latest release. It accepts only a
  non-draft, non-prerelease GitHub release marked immutable, uses GitHub's
  published asset SHA-256, resolves notices from the exact tag commit, and
  installs a newer version beside the currently leased executable. The failed
  operation is not looped or silently retried; the new version activates after
  restart.
- Rust caches that release lookup for 30 minutes even if the WebView reloads.
  It retains two verified dynamic generations for rollback, retires older
  exact generations only before runtime leases are issued, and moves a damaged
  generation to quarantine before repairing it from verified bytes.
- FFmpeg/FFprobe 8.1.2 are available on Windows x64 from the exact reviewed
  Gyan vendor ZIP. OSG selectively extracts and verifies only `ffmpeg.exe`,
  `ffprobe.exe`, the GPL license, and the build README. Linux and macOS remain
  unavailable until equivalent provenance-complete deliveries exist.
- Installing only b6.1.1's `ffprobe` is not an LGPL workaround: every audited
  target's exact `ffprobe` binary was built with `--enable-gpl` and `libx264`,
  and the macOS arm64 binary also has `--enable-nonfree`. A future standalone
  LGPL `ffprobe` would need a separate, reproducible four-target build.
- No tool executable is bundled in an OSG installer or committed to Git.

The recovery layer copies the toolbox's safe mechanics—bounded staging, exact
inventories, content receipts, version-directory publication, and runtime
leases—but not its mutable `sgt-runtime-bundles` tag or compile-time-only
yt-dlp update policy. OSG prefers an official immutable publisher release. A
future OSG mirror is accepted only as a byte-identical fallback in an
append-only immutable release; it must never invent a different component
identity.

The repository root now carries `LICENSE` and `THIRD_PARTY_NOTICES.md`; the
release gate checks both independently of this crate's per-tool notice files.
