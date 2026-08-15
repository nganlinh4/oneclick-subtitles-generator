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
  blob workers.
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

A release-readiness rule rejects any reachable Remotion dependency, runtime catalog, archive URL,
worker, command, permission or embedded resource, and any FFmpeg build configured `--enable-nonfree`.

The two already-published content-addressed assets stay in the pool, inert and unreferenced. They
are not deleted or overwritten.

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
