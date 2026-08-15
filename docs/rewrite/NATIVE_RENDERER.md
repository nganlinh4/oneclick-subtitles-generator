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

The specification is the measured feature matrix, not this document's prose. In summary: **70
persisted options** (54 subtitle-customization fields, 6 render settings, 10 crop settings), **30
shipped presets**, unlimited user presets, and a **121-entry font catalog**.

Behaviours that a naive reimplementation gets wrong, all of which are current shipped behaviour and
must be reproduced deliberately or fixed deliberately:

1. Two different scaling maths coexist. Sizes scale by `value * height / 1080` rounded to 2dp;
   margins use a fixed 1920x1080 percentage, so margins are resolution-independent and sizes are not.
2. `ease` and `ease-in-out` are the same quadratic, and neither is the CSS `ease` curve.
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

Font divergence is the worst of it: 115 selectable families, 88 absent from the preview's font
imports and silently substituted, while the export's managed pack contractually requires exactly one
family — Inter — and no font pack exists in this repository at all.

## Architecture

The binding constraint is not the GPU, it is the content security policy. `connect-src` is
`'self' ipc: http://ipc.localhost`: it does **not** include `http://127.0.0.1:*`, and `script-src`
carries neither `'wasm-unsafe-eval'` nor `blob:`. So the WebView cannot `fetch`, stream, or run WASM
against a native frame source. Only `<img>` and `<video>` element loads may reach the loopback media
server. The workspace is also `unsafe_code = "forbid"`, which constrains a raw surface approach.

The reference implementation resolves the equivalent problem in a way that is worth adopting and
that this repository's own constraints push us towards independently:

> **Text is shaped and rasterized once by the WebView into a packed atlas, staged to Rust as a few
> kilobytes of metadata, and Rust re-derives per-frame layout and animation from that metadata and
> emits textured quads.** There is no Rust text stack — no cosmic-text, no swash, no harfbuzz.

That is the decisive idea for OSG. A Rust text stack could not reproduce the WebView's shaping, so a
Rust-shaped export against a WebView preview would diverge on exactly the axis the migration is
required to guarantee. Baking glyphs in the WebView makes identical font bytes and identical shaping
a structural property rather than a test we have to keep passing.

The accepted design is therefore **one compositor and one glyph source**:

- **One pixel pipeline.** A native Rust/GPU compositor owns layout, animation math, crop and
  background composition, colour conversion and blending. It serves both surfaces; there is no
  second implementation of any of it.
- **One glyph source.** The editor WebView rasterizes the selected font into an atlas once per text
  revision and stages it. Preview and export consume the same atlas bytes.
- **One scene contract.** A strict, versioned, bounded, immutable scene DTO, with the same
  validation on both sides and a single deterministic frame-time sampler shared by video, audio and
  overlay so all three advance identically.
- **Preview transport.** Native frames reach the editor as element loads from the existing loopback
  capability server, which CSP already permits for `<img>`/`<video>`. No new origin, no WASM, no
  blob workers. What exactly those frames contain is settled below, because it decides how far the
  WYSIWYG guarantee actually reaches.
- **Encoding is a separate final stage** that cannot change composition pixels, over a reviewed,
  redistributable tool contract whose build configuration and notices are pinned and asserted.

This is not the "dual implementation fallback": there is a single compositor and a single shaping
engine. What is shared across the boundary is the atlas and the contract, not a duplicated renderer.

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

- **Ported — full-range colorimetry.** `MF_MT_VIDEO_NOMINAL_RANGE` must be `MFNominalRange_0_255`
  with BT.709 primaries and matrix, on both the input and output media types. The compositor emits
  full-range sRGB; declaring studio range silently remaps 0-255 into 16-235. The reference records
  this as a bug it had to fix, and for us it would break the WYSIWYG requirement outright — the
  export would be visibly washed out against the preview it is supposed to match.
- **Ported — bounded keyframe spacing.** A keyframe at least every 60 frames, so scrubbing an
  exported file in a WebView stays responsive.
- **Ported — the CPU-BGRA entry point.** `write_frame_cpu` takes exactly what a wgpu readback
  already produces, so the compositor and the encoder meet at a plain byte buffer with no shared GPU
  state. The GPU zero-copy path is a later optimization, not a requirement.
- **Corrected — timestamps must not accumulate a truncated duration.** The reference computes one
  frame duration as `10_000_000 * den / num` in integer arithmetic and reuses it. At 30000/1001 that
  truncates 333_666.67 to 333_666, so the audio and video drift apart by about a frame every 50
  minutes. We already have exact rational time in `osg-scene`, so each frame's presentation
  timestamp is computed from its own index and rounded once, and no error accumulates.
- **Corrected — the path never crosses the IPC boundary.** `MFCreateSinkWriterFromURL` needs a real
  filesystem path. It is constructed and consumed entirely inside Rust from an opaque export ID.

Two consequences to be honest about:

- **`unsafe` is unavoidable here.** Media Foundation is a COM API. The workspace stays
  `unsafe_code = "forbid"`; `osg-encode` is the single crate that downgrades it, every block carries
  a safety comment, and the unsafe surface stays inside the smallest possible wrapper. No other
  crate gains the allowance.
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

There are two things a preview could send, and the difference is not cosmetic:

1. **The fully composited frame** — decoded video, crop, canvas backfill and the subtitle layer, all
   blended on the GPU exactly as the export blends them, delivered as one image. This is identical
   to the exported pixel by construction, because it *is* the exported pixel.
2. **The subtitle layer alone**, delivered as a transparent image and laid over the HTML `<video>`
   by the browser. Cheap and responsive, but the final blend is then done by the WebView rather than
   by our compositor, over a frame the video decoder colour-managed on its own terms.

The second is not a second renderer — the same compositor produces the layer either way — but the
last step differs, so the result is close rather than exact. Chroma subsampling, the browser's own
colour management and its straight-alpha blend all land in the gap.

The rule is therefore about *which frame the user is judging*:

- **Paused, scrubbing, or adjusting any style** — the surfaces where a user decides whether the
  output looks right — must show the fully composited native frame. This is where the guarantee has
  to hold, and it is also where there is time to render one frame properly.
- **During continuous playback**, the overlay path is permitted for responsiveness. It must be
  understood and documented as an approximation, and it must never be the last thing shown: pausing
  re-renders the exact frame, so what the user finally looks at is always the real one.

Stating it this way keeps the honest property — *the frame you approved is the frame you get* —
without pretending that thirty composited frames a second through an image element is a sensible
way to scrub a video.

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

Remotion is removed, not deprecated. The measured blast radius is 124 files: 46 whole-file deletions,
5 moves, 73 in-place edits. It includes the `video-renderer` package and its workspace registration,
2 direct npm dependencies plus 144 lockfile records that become unreachable, the `osg-render` crate,
`render_catalog.rs`, two Tauri modules, 7 registered commands across their 4 synchronised
registration points, 2 permissions, 2 capability entries, 1 bundled resource, the delivery catalog
and its checkpoint source group, 91 readiness invariants across 7 functions, 12 i18n keys deleted and
9 reworded, and 128 tests.

Five `video-renderer/src` modules are Remotion-free and imported by the frontend; they move rather
than being deleted.

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
`RenderSettings`, `SubtitleCustomization` with all 54 fields, `CropSettings` with all 10, and a
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

Sorting the 115 unique families by what could honestly back them:

| Bucket | Count | What it means |
| --- | --- | --- |
| Declared Windows system faces | 11 | Real files on a clean Windows install. Already resolving. |
| Managed and hash-pinned today | 1 | Google Sans Flex, OFL-1.1, three subsets with sizes and SHA-256. |
| Substituted by the OS | 1 | Helvetica is redirected to Arial by Windows, so it can never be an identity. |
| Commercial or unclear provenance | 14 | Futura, Gotham, Hiragino Sans, PingFang SC, Arial Unicode MS and nine display faces. Cannot be redistributed without a licence the project does not have. |
| Open-licence candidates | 88 | Overwhelmingly Google Fonts under OFL-1.1 or Apache-2.0. |

So 88 of the 107 are recoverable through exactly the mechanism that already delivers Google Sans
Flex: a reviewed, content-addressed managed package with immutable sources, exact sizes and hashes,
an inventory and notices. Nothing about that is novel here — it is the same discipline, applied to
more files.

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

1. Freeze the specification: the feature matrix and the golden fixtures generated from current
   behaviour. Nothing is deleted before this exists.
2. Scene contract crate: versioned DTO, bounds, deterministic sampler, animation and layout math,
   golden-tested against the fixtures from step 1.
3. Atlas baking and staging, with font receipts.
4. GPU compositor and the frame server behind the existing capability transport.
5. Preview switched onto the native frames; the three drawing implementations collapse to one.
6. Encode/mux stage against the reviewed tool contract.
7. Parity suite across presets, options, resolutions and frame rates.
8. Removal, in the order above, with the readiness rule landing last.
