# Native renderer migration

Status: design accepted for implementation, migration in progress.
Supersedes: the Remotion render path (`video-renderer/`, `crates/osg-render`, the managed Remotion
runtime delivery) in its entirety.

## Why

The published Remotion runtime carries `@remotion/compositor-win32-x64-msvc`, whose FFmpeg is built
`--enable-gpl --enable-libx264 --enable-libx265 --enable-libfdk-aac`. Measured on the installed
runtime, that binary is on the hot path of every render: Remotion hard-maps `aac -> libfdk_aac` with
no configuration that changes it, and `remotion.exe` links the same `avcodec` DLLs.

Three escape routes were investigated and all fail:

- Excluding `ffmpeg.exe`/`ffprobe.exe` removes 495,616 of 49,821,927 compositor bytes (1.0%). The
  codecs are statically linked into the 48 MB of `avcodec-*.dll` that `remotion.exe` imports.
  Remotion also `chmod`s the binary before spawning, so absence is a hard failure with no fallback.
- An LGPL FFmpeg cannot serve this path: the output contract is MP4/H.264 and, with hardware
  acceleration disabled, Remotion selects `libx264` unconditionally. The repository's own lock file
  already records `"requiredEncoder": "libx264"`, `"effectiveLicenseFloor": "GPL-3.0-or-later"`.
- Substituting the separately downloaded Gyan FFmpeg works (verified end to end, with
  `audioCodec: 'mp3'` as the only MP4-preserving option) but fixes only encode provenance. The
  48 MB of GPL + fdk-aac DLLs remain re-hosted.

GPL was never the problem — the project already accepts a GPL FFmpeg downloaded direct from the
vendor. The problems are fdk-aac, which no source publication can cure, and that OSG **re-hosts** the
bytes. Judged against the repository's own audit standard the compositor scores
`approvedForRedistribution: false`; that standard is applied to `crates/osg-native-tools` and not to
`video-renderer/delivery`.

## What the renderer must reproduce

The specification is the measured feature matrix, not this document's prose. In summary: **72
persisted options** (56 subtitle-customization fields, 6 render settings, 10 crop settings), **30
shipped presets**, unlimited user presets, and a font catalog of **121 options over 115 unique families**.

Behaviours that a naive reimplementation gets wrong, all of which are current shipped behaviour and
must be reproduced deliberately or fixed deliberately:

1. Two different scaling maths coexist. Sizes scale by `value * height / 1080` rounded to 2dp;
   margins use a fixed 1920x1080 percentage, so margins are resolution-independent and sizes are not.
2. The legacy renderer made `ease` and `ease-in-out` the same quadratic. This is deliberately fixed:
   `ease` is the CSS `cubic-bezier(0.25, 0.1, 0.25, 1)` keyword curve, while `ease-in-out` retains
   the established quadratic. One generated bit-exact fixture keeps preview and export WYSIWYG.
3. The fade window makes a cue visible before its `start` and after its `end`.
4. Only the first matching cue renders, so overlapping cues silently vanish.
5. `backgroundOpacity` is concatenated as hex alpha, so an `#rrggbbaa` colour — which every
   validator accepts — yields a 10-character invalid colour and the background disappears.
6. `gradient` sets `background-clip: text`, which also clips the subtitle box away.
7. `glow` is a box-shadow, not a text glow.
8. `scale` animates in and out; `bounce` only in.
9. Typewriter truncates by UTF-16 code unit, splitting surrogate pairs, and is a no-op when
   `fadeInDuration` is 0.
10. Crop is never applied by FFmpeg. Frames are extracted full size and crop becomes CSS
    percentages, while output dimensions are derived from the crop ratio.
11. Trim is applied by FFmpeg `-ss/-to`, but cue timestamps are passed absolute and never rebased,
    so any `trimStart > 0` shifts every subtitle in the exported file.
12. The final duration is the actual extracted frame count, overriding the computed one.
13. The font-ready boundary never fails: it always continues after its timeout, so a slow font
    silently falls back.

Ten further fields (`multiShadowEnabled`, `shadowLayers`, `pulseEnabled`, `pulseSpeed`,
`shakeEnabled`, `shakeIntensity`, `gradientType`, `gradientColorMid`, `maxLines`,
`lineBreakBehavior`) are validated and persisted end to end but have no render effect and no UI.
Four more render but have no control: `textShadowOffsetX`, `wordWrap`, `rtlSupport`,
`textAlign: 'justify'`.

Every one of these is a decision to make explicitly during the migration, not a detail to discover
by accident afterwards.

## The problem this migration actually has to solve

OSG has **three** independent subtitle-drawing implementations today, not one:

1. the main editor preview — an HTML `<video>` plus a CSS overlay driven by a settings vocabulary
   (`position`/`boxWidth`/`opacity`/`lineSpacing`/`backgroundPadding`) that shares **zero** keys with
   the render DTO, with no animations, no fade, no stroke/gradient/glow, and unscaled pixel sizes;
2. the render-tab preview — a hand-maintained JavaScript near-duplicate of the export composition
   running in `@remotion/player`;
3. the export composition — TSX running in a pinned Chrome-for-Testing.

(2) and (3) share only two pure modules and the frozen defaults; everything else is duplicated by
hand and already disagrees in at least 13 measurable ways, including crop `objectFit` (`contain` vs
`cover`) and the canvas-background trigger. **Preview and export already do not match**, so this
migration is a correctness fix, not only a licensing one.

Font divergence is the worst of it: 115 unique families behind 121 selectable options, 88 absent
from the preview's font
imports and silently substituted, while the export's managed pack contractually requires exactly one
family — Inter — and no font pack exists in this repository at all.

## Architecture

The decisive constraint is text shaping. A Rust text stack cannot reproduce WebView shaping exactly,
so the WebView shapes and rasterizes each line once into a bounded atlas. Both preview and export use
those same pixels and the same strict scene contract.

Continuous preview and offline export deliberately use different execution engines because their
cost models differ:

- **Preview is a persistent Canvas2D compositor.** It draws the already-decoded `<video>` directly,
  then draws the exact shaped atlas mask with the scene's crop, background, transform, decoration,
  easing and typewriter rules. `requestVideoFrameCallback` drives source frames; React never renders
  per frame. There is no PNG encoder, IPC frame transfer, capability URL, image decode, or frame
  cache in the playback loop.
- **Export is Rust + wgpu.** Media Foundation decodes the source, the native compositor applies the
  same scene maths and atlas pixels, and Media Foundation encodes the finished frame. Export remains
  independent of the WebView's video decoder and of Canvas2D.
- **The contract is shared, not guessed twice.** Frozen JavaScript/Rust maths fixtures cover scale,
  margins and easing. Real-binary journeys capture the canvas at an exact playhead, independently
  decode the exported MP4 at that playhead, and require high structural similarity.
- **The glyph source is singular.** The WebView bakes line masks from the shipped font bytes. Preview
  consumes them directly and export stages the same bounded atlas descriptor. No CSS subtitle layer,
  browser `fillText` substitute, Rust text shaper, or silent font fallback is allowed.

This is the same responsiveness principle used by `screen-goated-toolbox`: the interactive surface
stays on the WebView's direct video-to-canvas path, while expensive native decoding and encoding are
reserved for export. WYSIWYG is enforced by shared inputs plus decoded-pixel comparison rather than
by making playback perform an offline export thirty times per second.

### Encoding — settled: the operating system's own codecs, not a bundled FFmpeg

The FFmpeg problem that started this migration is solved by not shipping an encoder at all.
`crates/osg-encode` drives the **Windows Media Foundation `IMFSinkWriter`** to produce H.264 in MP4
with AAC audio, hardware-accelerated where the machine offers it. The technique is ported from
`screen-goated-toolbox` (`src/overlay/screen_record/mf_encode.rs`, `mf_audio.rs`), which has been
running this path in production.

Why this closes the licensing question rather than relocating it: the H.264 and AAC codecs are part
of Windows, licensed by Microsoft to the user who is running the machine. We redistribute no codec,
no `--enable-nonfree` binary, no GPL-licensed library, and no downloaded tool. There is nothing left
to write a notice for, no runtime package to verify, and no delivery catalog entry to keep current.
The 1% of Remotion's bytes that were `ffmpeg.exe` become 0%.

Three details are ported deliberately, and two are corrected:

- **Ported and measured — explicit colorimetry.** The CPU-BGRA input and output media types remain
  full-range BT.709. The GPU path also declares the compositor's DXGI input full-range, but declares
  the hardware-produced H.264 output studio-range: a real encode/decode probe showed that Windows'
  hardware transform writes studio-range samples. Calling that bitstream full-range remapped an
  input value of 30 to 42. The pinned GPU round trip now has mean channel error below 0.75, a 99.9th
  percentile no greater than 4, and a maximum no greater than 16; a one-pixel subtitle shift exceeds
  those tail bounds by an order of magnitude.
- **Ported — bounded keyframe spacing.** A keyframe at least every 60 frames, so scrubbing an
  exported file in a WebView stays responsive.
- **Completed — the production path never stages frame pixels on the CPU.** Media Foundation
  decodes to NV12 D3D11 surfaces; a D3D11 video processor applies aperture, rotation and colour into
  a three-slot shared BGRA ring; wgpu imports those surfaces on the exact same adapter and composites
  into a second shared ring; `MFCreateDXGISurfaceBuffer` hands GPU-resident frames to the SinkWriter.
  D3D11/D3D12 shared fences, keyed mutexes and bounded completion waits make ownership explicit.
  Decode, compose and encode run as three back-pressured stages, and Windows has deliberately no
  CPU/readback fallback that could silently restore the slow path. The CPU-BGRA encoder entry point
  remains as independently tested codec infrastructure, not as the shipped export route.
- **Corrected — timestamps must not accumulate a truncated duration.** The reference computes one
  frame duration as `10_000_000 * den / num` in integer arithmetic and reuses it. At 30000/1001 that
  truncates 333_666.67 to 333_666, so the audio and video drift apart by about a frame every 50
  minutes. We already have exact rational time in `osg-scene`, so each frame's presentation
  timestamp is computed from its own index and rounded once, and no error accumulates.
- **Corrected — the path never crosses the IPC boundary.** `MFCreateSinkWriterFromURL` needs a real
  filesystem path. It is constructed and consumed entirely inside Rust from an opaque export ID.

Two consequences to be honest about:

- **`unsafe` is unavoidable here.** Media Foundation and D3D11/D3D12 interop are COM APIs. The
  workspace stays `unsafe_code = "forbid"`; exactly three crates downgrade it — `osg-encode`,
  `osg-decode`, and the narrowly scoped `osg-gpu-video` bridge. Each narrows the exception to that
  single lint, mirrors every other workspace lint verbatim, and additionally turns on
  `clippy::undocumented_unsafe_blocks` and `clippy::multiple_unsafe_ops_per_block`, so the compiler
  enforces the audit instead of review custom. All unsafe lives under each crate's `src/mf/`
  directory or, for the bridge, beside the exact ownership invariant it implements. No other crate
  gains the allowance.

  This originally read "`osg-encode` is the single crate", which the decoder made false. The GPU
  bridge is the third and final exception: it is the only crate permitted to exchange raw D3D
  resources, handles or fences, and its public API exposes none of them.
- **Parity is proven at the frame, not at the bitstream.** Hardware encoders differ between vendors
  and driver versions, so an H.264 file is not bit-reproducible. The determinism contract therefore
  binds the compositor's RGBA output, which is what the parity fixtures compare. The encoder is
  required only to be a faithful, full-range, correctly-timed carrier of those pixels.

Non-Windows targets get an explicit `UnsupportedPlatform` error, not a silent fallback to some other
encoder. The shipped release target is Windows; when another platform is added it gets its own
audited backend (AVFoundation on macOS) behind the same trait.

### Decoding, which the encoder decision alone does not cover

Removing FFmpeg removes the frame **extractor** as well as the encoder. The shipped path pulled
source frames out with `ffmpeg.exe`; nothing else in the product can do that. The answer is the same
technology: `IMFSourceReader` decodes the source video, hardware-accelerated, from the same OS codec
set that the SinkWriter encodes with. The reference has this working in
`src/overlay/screen_record/mf_decode.rs`.

The full media path is therefore: **MF SourceReader decodes → wgpu composites → MF SinkWriter
encodes**, with `symphonia` decoding source audio in pure Rust because the audio mix has to be
deterministic and bit-reproducible in a way a hardware decoder does not promise.

Three things must be got right, and two of them are lessons the reference paid for already:

- **Seeking is not frame-exact.** `IMFSourceReader` seeks to a keyframe, not to a frame index. An
  export that trusted the seek would sample the wrong source frame near every cut. Each output frame
  must be matched to its source frame through the exact rational timeline, decoding forward from the
  keyframe where necessary. This is the same requirement that makes preview and export agree, so it
  is not extra work — it is the same sampler.
- **A decoded frame must keep its `IMFSample` alive.** The reference documents that the DXGI surface
  allocator reclaims the texture subresource as soon as the sample refcount reaches zero, even while
  the GPU is still reading from it. A decoded-frame type that drops the sample early produces
  intermittent corruption that looks like a compositor bug.
- **`MFShutdown()` must not be called.** The reference makes its shutdown a deliberate no-op, because
  tearing down the shared MF platform breaks every later use of it in the same process. The OS
  reclaims everything at exit.

This also explains why the compositor takes a video underlay rather than only drawing subtitles on a
transparent ground: crop, flip, and the solid/blur canvas backfill are all operations on the decoded
frame, and doing them in the same GPU pass as the subtitle layer is what keeps one pixel pipeline
rather than two. Those fields are exactly the ones the parity ledger still lists as pending.

### What the preview actually shows, and how far the guarantee reaches

The preview is one persistent canvas containing both video and subtitles. The underlying `<video>`
remains the browser's decoder and clock but is not a second visible surface. Every draw uses the
current source frame, composition viewport, and the active cue's shaped atlas line.

The guarantee has two independently checked parts:

- **Responsiveness.** A six-second real-video playback journey requires media time and canvas
  revisions to advance, reports zero long tasks, and rejects runaway heap growth.
- **Pixel parity.** A real export journey freezes a cue playhead, saves the exact canvas composition
  viewport, decodes the MP4 independently with FFmpeg, and compares the two images. Letterbox bars
  outside the composition are excluded from the oracle because they are editor chrome, not output.

The preview never falls back to raw video while claiming success. `empty` means the project has no
cues; `between-cues` means the playhead is outside every cue; a staging or rendering failure is a
typed refusal surfaced outside the picture. A healthy cue must increment the canvas frame revision
and publish its cue index before a workflow can call it ready.

### Atlas paging — what a document is allowed to be

One `GlyphAtlasDescriptor` carries one cell table, bounded at `MAX_GLYPH_COUNT` (1,024) cells, and a
`CueRun` indexes exactly one table. The bound is on the **alphabet**, not on the cue count: Latin
saturates at a few dozen cells however long the track, so a single atlas was never a limit there.

A large character set is different. A Chinese film uses a few thousand distinct ideographs, a Korean
track reaches into the syllable blocks, an emoji-heavy lyric video keeps introducing new sequences.
Those are ordinary product documents and they overflowed one table, so the export refused them
outright. That was an *incidental implementation ceiling*, and it is gone.

An export's cue list is now split across **pages**. Each page is exactly the descriptor it always
was — same shape, same validators, same staging frame, same content hash — and each cue carries the
page index its cells belong to. Nothing about the draw changed, because
`osg_scene::cues::active_cue_at` selects **exactly one cue per frame**: a frame samples exactly one
page, the compositor binds that page, and resident texture memory is one page whatever the document
is. There is no texture array, no per-vertex page id, and no extra draw call.

Two consequences worth stating, because both were previously refusals:

- **A cue's cells no longer depend on the cues it is baked beside.** The contextual-versus-isolated
  cell decision used to be one verdict for the whole document, so a single long cursive line dragged
  every other cue down to isolated forms with it. It is now per cue — which also closes a real
  preview/export gap, since the preview bakes one cue and the export bakes them all.
- **A document may mix text directions.** `run_align` reads the alignment from the atlas, because
  CSS `start` resolves against the paragraph's own direction and only the shaper can decide it. One
  atlas therefore carries one alignment — so a right-to-left cue and a left-to-right one simply land
  on different pages instead of the document being refused. Pages are keyed by alignment rather than
  being contiguous stretches of cues, so a track that alternates direction produces two pages, not
  one per cue.

What is still refused, and refused rather than truncated, because a page silently dropped would be a
stretch of subtitles missing from the exported file:

| Bound | Value | Meaning |
| --- | --- | --- |
| `maxAtlasPages` | 32 | 32,768 distinct glyph forms — past every script the product ships fonts for |
| `maxTotalAtlasBytes` | 256 MiB | what the staging registry holds resident; reached first by a large font size at 4K |
| per-cue | `MAX_GLYPH_COUNT`, atlas dimension | a single cue no page could hold; there is no smaller unit to split into |

These are **declared budgets with actionable messages** — reduce the font size, or the number of
distinct characters — not accidents of an implementation. A document past them names the bound it
broke.

### Determinism

No RNG anywhere. Every effect is a pure function of source time. Shake and noise take their phase
from the timestamp, so seeking is exact and repeatable. One canonical speed/frame-time sampler is
re-exported to every consumer rather than reimplemented per call site.

## Parity policy

Parity is executable, not a review slogan.

- Golden fixtures lock the ported math to the behaviour being replaced. They are generated from the
  current implementation before it is deleted, and asserted from both languages.
- For every shipped preset and every independent option, preview and export frames are compared at
  start, middle, end, and at animation transition boundaries, across representative 720p/1080p/4K,
  landscape/portrait/square, and every supported frame rate.
- Both paths use the same source asset, scene revision, font receipts, timestamp rational, colour
  space, alpha rules and effect phase.
- Comparisons are pixel-exact where the render target is identical. Any scale or encoder tolerance
  is numerically bounded, justified and tested, and may never absorb layout, timing, font or effect
  drift.
- Hostile coverage: Unicode, Vietnamese, Korean, RTL, emoji and fallback glyphs, long and multiline
  text, custom presets, extreme valid crop and margins, overlapping cues, high frame rates,
  cancellation, stop/restart, stale project and run ownership, device loss, disk full, encoder
  failure, and export recovery.

## Removal

Remotion is removed, not deprecated. Re-measured against the tree on 2026-08-16 with
`git ls-files | xargs grep -ril remotion`, so this is the surface as it stands today rather than the
earlier estimate:

| Area | Tracked files | Disposition |
| --- | --- | --- |
| `video-renderer/` | 26 | Deleted, except the one module that moves (see below). |
| `crates/osg-render/` | 8 | `contract.rs` survives and moves; `engine.rs`, `protocol.rs`, `runtime.rs` and the crate shell go. |
| Everything else referencing Remotion | 54 | In-place edits. |

The 54 span the CI workflow, `.gitignore`, five prose documents, `build.rs`, the permission and
capability files, `render.rs` and `render_packages.rs`, three `osg-engine-packages` modules,
`osg-media/src/binary.rs`, the managed-delivery checkpoint, `licenses/DELIVERY-NOTICES.md`,
`package.json` and `vite.config.mjs`, eight scripts (four of which — the runtime archive builder, the
two manifest generators and the desktop boundary checker — exist only for Remotion and are deleted
outright), the readiness and command-contract checkers, the visual freeze baseline, nine `src/`
components including both preview surfaces, four i18n files, and `renderService`/`renderPackageService`.

Two pieces of incidental cruft to sweep at the same time: `src/i18n/locales/ko/videoRendering.json.bak`
is a tracked backup file, and `electron-logs/` is a build log from the removed Electron stack.

Five `video-renderer/src` modules are Remotion-free. Re-measured on 2026-08-16, only **three** are
imported by the frontend at all, and two of those three exist only because the WebView is still
drawing subtitles itself:

| Module | Imported by `src/` | Disposition |
| --- | --- | --- |
| `subtitleCustomizationDefaults.ts` | 1 | **Must survive.** It is the schema authority that `defaultCustomization.js` re-exports, and the parity ledger is asserted against it. |
| `subtitleVisualMath.ts` | 2 | Deletable once step 5 lands. `osg-scene` already reimplements this, tested against bit-exact fixtures generated from it. |
| `subtitleAnimationEasing.ts` | 2 | Deletable once step 5 lands, for the same reason. |
| `types.ts` | 0 | Deletable. |
| `components/SubtitleCustomization.tsx` | 0 | Deletable. The repository-root React frontend has its own controls; this is the renderer package's copy. |

So the removal is cleaner than first planned: one module genuinely moves, two more leave with the
WebView's drawing path, and two were never reachable from the application at all. This is also the
concrete form of "the three drawing implementations collapse to one" — the second implementation
disappears here.

**Correction to "the `osg-render` crate" above, found by reading it rather than assuming.** The
crate is not uniformly Remotion-bound and must not be deleted wholesale:

| Module | Lines | Remotion references | Disposition |
| --- | --- | --- | --- |
| `contract.rs` | 704 | **0** | **Keep and move.** |
| `engine.rs` | 1583 | 0 by name, but it exists to drive the Remotion worker | Delete. |
| `protocol.rs` | 274 | 0 by name, but it is the worker's framed stdio protocol | Delete. |
| `runtime.rs` | 647 | 12 | Delete. |
| `error.rs` | 39 | 2 | Keep the variants the contract needs, drop the rest. |

`contract.rs` is the validated request the WebView already speaks: `RenderRequest`,
`RenderSettings`, `SubtitleCustomization` with all 56 fields, `CropSettings` with all 10, and a
checked enum for every vocabulary the UI can send. It is the typed boundary the frontend was written
against, and rewriting it alongside a new renderer would risk exactly the silent drift the parity
ledger exists to catch — for no benefit, since nothing in it mentions the engine that happened to
consume it.

The native pipeline therefore *converts* a validated `RenderRequest` into an `osg-scene::Scene` plus
the style, crop and audio inputs. That conversion is the single place every parity decision in the
ledger is applied, which makes those decisions reviewable in one file instead of scattered through a
renderer.

A release-readiness rule rejects any reachable Remotion dependency, runtime catalog, archive URL,
worker, command, permission or embedded resource, and any FFmpeg build configured `--enable-nonfree`.

The two already-published content-addressed assets stay in the pool, inert and unreferenced. They
are not deleted or overwritten.

### What removal does to the licensing position

`THIRD_PARTY_NOTICES.md` currently lists five open notice items for the owner to resolve before
distribution. Removing Remotion and encoding through the operating system's codecs closes three of
them outright and most of a fourth, because the components they concern stop being redistributed:

| Open item | After removal |
| --- | --- |
| GPL FFmpeg with x264, x265 and FDK-AAC redistributed with no licence files and no source offer | **Closed.** Nothing FFmpeg-derived is shipped or downloaded. |
| MPL-2.0 `mediabunny` redistributed in compiled form with no notice or source reference | **Closed.** It only existed inside the render bundle. |
| Node.js and Chrome for Testing provenance asserted but not pinned by URL and hash | **Closed.** They were the render runtime's hosts. |
| Components delivered with no licence file, so the named terms are upstream's published text rather than bytes we read | **Mostly closed.** FFmpeg, x264, x265, FDK-AAC, libvpx, the GCC runtimes, MinGW-w64 winpthreads, zlib, the MSVC 2010 runtime, Node.js and Chromium all leave with the render runtime. |
| ASR and speech runtime entries taken from committed catalogs rather than from delivered bytes | **Still open.** Unrelated to rendering; must be resolved on its own. |

`licenses/DELIVERY-NOTICES.md` is entirely about the managed Remotion runtime and is deleted with
it. The "Downloadable video render runtime" section of `THIRD_PARTY_NOTICES.md` goes the same way.

This is the single largest reason the migration is worth its cost. The alternative — keeping
Remotion and making its notices defensible — required writing a source offer for a GPL FFmpeg build
that also has `--enable-nonfree` set, which no notice can make redistributable.

Two things this does **not** resolve, and neither should be assumed closed by it: the owner's choice
of root licence and notice policy, and the ASR/speech delivery verification above.

### The 107 unavailable fonts are a delivery gap, not a capability loss

`fontIdentity` reports 107 of the 121 catalog options as unavailable on Windows. That number reads
like the migration is taking something away, and it is worth being precise about what is actually
happening: the shipped renderer never drew those families either. It asked for them by CSS name,
got a substitute, and said nothing. The capability was already absent; only the silence is new.

**Two figures were circulating and both were quoted as fact — "121 options, 107 unavailable" and
"115 families, 88 recoverable". They were measuring different denominators.** Both are now computed
by one function, `reportFontInventory` in `src/services/fontInventory.js`, and asserted by its test.
Nothing below is transcribed; every number comes from code that runs.

Counted as OPTIONS, which is what the catalog offers a user: **121 options**, 116 distinct values,
**115 unique families**, 17 groups. On Windows, 14 options resolve and **107 do not**.

Counted as FAMILIES, which is what a delivery package would contain:

| Bucket | Count | What it means |
| --- | --- | --- |
| Declared Windows system faces | 11 | Real files on a clean Windows install. Already resolving. |
| Managed and hash-pinned today | 1 | Google Sans Flex, OFL-1.1, three subsets with sizes and SHA-256. |
| Substituted by the OS | 1 | Helvetica is redirected to Arial by Windows, so it can never be an identity. |
| Commercial or unclear provenance | 14 | Futura, Gotham, Hiragino Sans, PingFang SC, Arial Unicode MS and nine display faces. Cannot be redistributed without a licence the project does not have. |
| Open-licence candidates | 87 | Overwhelmingly Google Fonts under OFL-1.1 or Apache-2.0. |
| Not a real family | 1 | `Noto Sans Vietnamese`. Vietnamese coverage lives in Noto Sans itself, so this option could never have resolved to anything. |

11 + 1 + 1 + 14 + 87 + 1 = 115. The earlier "88 recoverable" is explained rather than contradicted:
it was 87 deliverable candidates plus the family that does not exist.

So **87 families** are recoverable through exactly the mechanism that already delivers Google Sans
Flex: a reviewed, content-addressed managed package with immutable sources, exact sizes and hashes,
an inventory and notices. Nothing about that is novel here — it is the same discipline, applied to
more files. Expressed as options, the 107 unavailable ones are 103 unique families, of which 102 are
unavailable and one is Helvetica, which the OS redirects.

Two things block it, and neither may be worked around:

1. **Publishing font payloads to the delivery pool is an external publication.** It needs explicit
   authorization at that step, like every other upload.
2. **Each family's licence must be verified against the delivered bytes**, not assumed from the
   family name. The bucket above is a starting inventory, not a licence finding. The existing
   notices already distinguish these two things and this must not blur them.

Until then the honest state is the one the code already reports. What must not happen is the
failure mode the notices warn about elsewhere: making a font appear available by silently drawing
something else, which is precisely the behaviour being removed.

One catalog defect found while sorting this: **`Noto Sans Vietnamese` is not a real family.**
Vietnamese coverage lives in Noto Sans itself, so that option could never have resolved to anything
and should be corrected rather than delivered.

## Order of work

Status as of 2026-08-16, after wave 12. Nothing is marked done here without a measured gate behind
it, and this table is kept synchronised with executable state — if it disagrees with
`src/platform/renderParityLedger.js` or with a test count, the table is the thing that is wrong.

| # | Step | State |
| --- | --- | --- |
| 1 | Freeze the specification: feature matrix and golden fixtures from current behaviour. Nothing is deleted before this exists. | **Done.** Fixtures carry IEEE-754 bit patterns, because JS and `serde_json` disagreed by one ULP. |
| 2 | Scene contract crate: versioned DTO, bounds, deterministic sampler, animation and layout maths, golden-tested against step 1. | **Done.** `osg-scene`, 124 tests, including the mirror and validation of the baker's authoritative `AtlasLayout`. |
| 3 | Atlas baking and staging, with font receipts. | **Done.** The baker shapes, transforms, wraps, aligns, justifies and reorders to visual order through a real UAX #9 subset cross-checked against a reference implementation. `fontIdentity.js` resolves or honestly refuses, and `fontInventory.js` reports the reconciled catalog. Staging forwards the layout verbatim; `osg-scene::glyph` validates it as strictly as the glyph table. |
| 4 | GPU compositor and the frame server behind the existing capability transport. | **Done.** `osg-compositor`, 124 tests on a real Intel/Vulkan adapter. It **consumes** the emitted layout — glyph *i* of line *l* at `penXPx[i]`, baseline `baselineYPx` — and has no pen accumulator, no re-wrap, no re-align, no reorder. Video underlay with crop, flip and canvas backfill; stroke, shadow, glow, border, radius, gradient and typewriter. Seek equals play, proven byte-identical with every effect enabled. |
| 5 | Preview switched to a persistent WebView canvas fed by the live video element and the exact shaped line atlas used by native export. | **Complete.** Continuous playback performs no native frame render, PNG encode, IPC frame transfer, capability-URL load, or React frame loop. Export remains the Rust/GPU compositor; shared atlas pixels, scene maths, and decoded-frame SSIM prove WYSIWYG. |
| 6 | Encode/mux stage. | **Done, both directions.** `osg-encode` writes H.264/AAC MP4 through Media Foundation, ffprobe-verified full-range BT.709. `osg-decode` reads through `IMFSourceReader` with frame-exact sampling, 58 tests. `osg-audio` decodes, resamples and mixes, 100 tests. No FFmpeg anywhere. |
| 6b | Export orchestration: a validated request to a finished file. | **Done.** `osg-export`, 65 tests including 8 real end-to-end exports. The single place every parity decision is applied. |
| 7 | Parity suite across presets, options, resolutions and frame rates. | **Input frozen, gate not built.** Field coverage is **2 of 72 pending** (`maxWidth`, awaiting its caller; `rtlSupport`, awaiting contextual cell baking). `scripts/generate-parity-matrix.mjs` freezes what the gate must cover — 30 presets, 72 options, 155 field-value renders, 9 texts, 4 output shapes — and `npm run test:parity-matrix` fails if it goes stale. The gate that renders and compares them does not exist yet. |
| 8 | Removal, in the order above, with the readiness rule landing last. | **Not started, and correctly blocked** — nothing is removed until step 7 proves the replacement. |

Step 6 turned out to be the step that removed the licensing problem entirely rather than relocating
it, and step 7 is the one that decides when step 8 may begin.
