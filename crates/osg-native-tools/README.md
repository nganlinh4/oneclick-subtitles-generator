# OSG native tools

This crate manages optional native command-line tools without exposing URLs,
filesystem paths, manifests, or process arguments to the WebView.

- `yt-dlp` 2026.07.04 and Deno 2.9.5 are downloaded directly from immutable
  upstream release URLs and verified by exact size and SHA-256 before use.
- Upstream license and third-party-notice files are fetched from exact commit
  revisions and become part of the verified installed tree.
- The managed `yt-dlp` binary cannot self-update; only a reviewed catalog
  change can change its bytes.
- FFmpeg/FFprobe intentionally remain unavailable. OSG requires `libx264`, so
  an honest build is GPL-capable and needs a complete corresponding-source and
  notice set. Neither reviewed producer supplies an immutable, provenance-
  complete four-target set. In particular, `eugeneware/ffmpeg-static` b6.1.1
  republishes a macOS arm64 build configured with `--enable-nonfree`, which
  FFmpeg classifies as unredistributable.
- Installing only b6.1.1's `ffprobe` is not an LGPL workaround: every audited
  target's exact `ffprobe` binary was built with `--enable-gpl` and `libx264`,
  and the macOS arm64 binary also has `--enable-nonfree`. A future standalone
  LGPL `ffprobe` would need a separate, reproducible four-target build.
- No tool executable is bundled in an OSG installer or committed to Git.

The repository currently has no root `LICENSE` or third-party-notice document.
That must be resolved before shipping any application release, independently
of this crate's per-tool notice handling.
