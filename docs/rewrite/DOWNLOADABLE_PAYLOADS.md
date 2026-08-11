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
2. **OSG append-only multi-bundle pool** — a content-addressed asset under the development pool tag.
   This is for composite Python environments, deterministic renderer bundles, or cross-platform
   builds that no publisher ships. The tag may collect new assets, but an existing asset is never
   replaced or deleted and every asset name contains its archive hash. Catalogs trust the exact
   name, length, and SHA-256—not the moving state of the release page.
3. **Embedded application resource** — permitted only for the small protocol bootstrap workers that
   cannot execute without a separately verified managed runtime. Native executables, interpreters,
   models, browser engines, and voice packs are forbidden here.

No tier may silently fall back to `PATH`, a package manager, `pip`, `npm`, a mutable `latest` URL, or
an unverified file already on disk. Mirrors must deliver the same reviewed component identity; a
hash mismatch never becomes an implicit update.

## Current payload decisions

| Payload | Delivery | Activation | EXE impact |
| --- | --- | --- | --- |
| yt-dlp 2026.07.04 baseline + immutable newer stable releases | Direct official GitHub release on four targets; failure-triggered checks require an immutable stable release, GitHub asset digest, exact tag commit, and exact notices | A verified install activates in the running app; a newer version is published beside a leased binary and the failed operation is not silently replayed | Catalog and recovery metadata only |
| Deno 2.9.5 | Direct official GitHub release on four targets | Verified install activates in the running app under a held tool lease | Catalog metadata only |
| FFmpeg/ffprobe 8.1.2, Windows x64 | Direct fixed Gyan vendor ZIP; selective extraction of two executables plus license/build notice | Verified install activates in the running app under a held media-tool lease | Catalog metadata only |
| FFmpeg/ffprobe, Linux/macOS | Disabled until reviewed direct artifacts exist; otherwise build a provenance-complete OSG mirror bundle | Not available | None |
| ASR engines | Split future packages into a shared per-platform runtime bundle plus direct, revision-pinned model files where publishers provide them | Package lease retained by worker | Worker bootstrap only |
| Speech engines | Shared per-platform Python/wheel runtime bundle; direct pinned model files where licensing permits; backend-specific overlays | Package lease retained by worker | Worker bootstrap only |
| Remotion renderer | Direct official Node and Chrome-for-Testing components, exact npm renderer/binary closure, offline font pack, and an OSG composition bundle | Managed render-runtime lease | Worker bootstrap only |
| Gemini voice samples | One platform-neutral, content-addressed OSG pool archive containing the exact 30 reviewed WAVs | Installed automatically on first preview; resolved through a tokenized native media capability; immediately removable | Catalog metadata only |
| Google Sans Flex | Current official Google Fonts webfont in a dedicated managed UI-font package; Google/SIL sources first and the OSG pool only as a byte-identical reviewed fallback | Automatic during desktop bootstrap with bounded system-font fallback | The retired 4.6 MiB TTF is absent; the three WOFF2 subsets total 459 KiB on demand |

The voice archive is optional because preview is an explicit user action. The shell font is not:
its managed package is installed before the first application window becomes visible so the UI never
renders and reflows in a fallback typeface. Google now publishes Google Sans Flex through the
open-source Google Fonts catalog. The current verified WOFF2 package replaces the retired 4.6 MiB
TTF with 459 KiB of Vietnamese, Latin Extended, and Latin subsets; Korean keeps the established
system/Noto fallback because Google Sans Flex contains no Korean glyph set.

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
- The OSG pool is independent of the toolbox repository. The toolbox is a workflow reference only;
  no application catalog or build step may download its assets.

## Development parity and bundle publication

Debug and release executables resolve optional runtimes through the same checked-in catalogs and
receipt-verified package stores. Debug builds do not search the repository, `local-runtime-bundles`,
virtual environments, adjacent executable directories, bundled optional payloads, or system
`PATH`. The three small Python/Node protocol bootstraps remain Tauri resources, but they cannot run
without a separately installed managed package.

An already-installed package is allowed offline only because it was previously downloaded through
the catalog and its receipt and complete file inventory are revalidated. A developer-created
directory without that receipt is never adopted. This preserves normal offline reuse without making
development more permissive than the shipped app.

`npm run tauri:dev` runs the remote checkpoint preflight before Tauri starts. Rust's desktop build
script independently runs the local checkpoint, so invoking Cargo directly cannot bypass it. The
checkpoint binds package-producing source files to the exact delivery catalogs and to the 28
server-reported assets in `osg-runtime-bundles-v1`.

When a bound source changes, use this order in the same commit:

1. Build only the affected package deterministically outside the application tree.
2. Give every new archive/manifest a content-addressed name; never overwrite or delete a published
   asset.
3. Upload it to the OSG pool (official external sources still remain the first choice).
4. Read the release back and verify GitHub's byte length and SHA-256 digest.
5. Update the affected catalog, then run
   `python -I -B scripts/check-managed-delivery-contract.py --write`.
6. Run `npm run verify:managed-delivery`. Commit the source, catalog, and refreshed checkpoint
   together.

The write command refuses to bless changed package sources when their content-addressed delivery
identity did not also change. CI repeats the hostile checkpoint tests and remote read-back. Package
authoring may use local staging directories; the application host never consumes them.

## Size gate

Release CI runs `check-desktop-payload-size.mjs`. It reports the executable, frontend resource total,
and every embedded file over 256 KiB; caps the compiled frontend at 30 MiB, the measured Windows
executable at 16 MiB, and unmeasured Linux/macOS executables at 48 MiB; and fails if a native
executable, interpreter, model, Chromium/Node payload, or unreviewed
Tauri resource appears. The retired 30-voice static set remains hash-recorded by the visual contract,
while the working feature is exercised through the verified package flow. A size decrease is accepted
only when the corresponding feature remains reachable through a verified package flow.

The Rust desktop shell itself uses one codegen unit, full LTO, `opt-level = "z"`, aborting panics, and
symbol stripping. CPU-heavy media, model, and render work executes in managed child runtimes, so the
shell is optimized for distribution size rather than duplicating throughput-oriented native code.
