# Native renderer

Subtitle preview and video export are native. The old browser-based renderer and its bundled
FFmpeg/Chromium payload are gone; nothing in the installer encodes video except Windows itself.

## Shape

- **One glyph source.** The WebView shapes and rasterizes each subtitle line once, from the shipped
  font bytes, into a bounded glyph atlas (`src/platform/glyphAtlas*.js`). Preview and export both
  use those pixels. There is no Rust text shaper, no CSS subtitle layer and no silent font fallback.
- **Preview** is a persistent Canvas2D compositor over the playing `<video>`, driven by
  `requestVideoFrameCallback`. No frame crosses IPC.
- **Export** is Rust: `osg-render` validates the path-free request, `osg-scene` holds the shared
  scene maths, `osg-decode` decodes the source with Media Foundation, `osg-compositor` composites
  with wgpu, `osg-audio` decodes and mixes audio in pure Rust (symphonia), and `osg-encode` writes
  H.264/AAC MP4 through the Media Foundation sink writer. `osg-export` runs the pipeline.
- **Zero-copy GPU path** (`osg-gpu-video`). Decoded NV12 surfaces, a D3D11 video processor, wgpu
  composition and the encoder share GPU textures on one adapter, with explicit fences and keyed
  mutexes; decode, compose and encode run as three back-pressured stages. There is deliberately no
  CPU fallback: a machine without a hardware GPU gets a typed `renderDeviceLost` refusal. WARP has
  no D3D11 video support, which is why hosted CI runners skip the export tests.

## Rules that matter

- `unsafe` is forbidden workspace-wide except in `osg-encode`, `osg-decode` and `osg-gpu-video`,
  which also enable `clippy::undocumented_unsafe_blocks` and `multiple_unsafe_ops_per_block`.
- Frame timestamps come from exact rational time per frame index, so 29.97 fps never drifts.
- The GPU encode declares studio-range output (what the hardware writes); the CPU path is full range.
- Encoded bytes differ between GPU vendors, so determinism is asserted on composited frames, not on
  the MP4 bitstream.
- Non-Windows targets return `UnsupportedPlatform` rather than falling back to another encoder.

## Parity

`renderParityLedger.js` records what every persisted subtitle option is meant to do;
`crates/osg-export/tests/fixtures/parity-matrix.json` is generated from the real JavaScript modules
(`scripts/generate-parity-matrix.mjs`, guarded by `npm run test:parity-matrix`).
`crates/osg-export/tests/parity.rs` renders every preset and field value, checks seek-equals-play
and that inert options stay inert, and compares decoded exports against composed frames within a
measured tolerance. Real-binary journeys compare a preview canvas against the decoded export at the
same playhead.
