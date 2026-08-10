# Third-party notices

OneClick Subtitles Generator is licensed under the MIT License. Its desktop shell and optional
downloadable components incorporate or interact with third-party software under their respective
terms. Exact versions and integrity hashes are pinned by `Cargo.lock`, `package-lock.json`, and the
delivery catalogs below.

## Desktop and web application

- Tauri and the Rust crates recorded in `Cargo.lock` retain their crate metadata and license files.
- React, Vite, Remotion, and the npm packages recorded in `package-lock.json` retain their package
  license metadata. Remotion is licensed under its upstream license and is not considered part of
  this repository's MIT grant.
- Material Symbols are used under Apache-2.0. The application does not bundle Product Sans.
- `src/assets/fonts/GoogleSansFlex.ttf` is governed by its accompanying upstream font terms and is
  tracked by the frozen desktop payload audit; it is not relicensed by this document.

## Downloadable native tools

- FFmpeg/ffprobe 8.1.2 Windows essentials build: GPL-3.0-or-later. The reviewed artifact and source
  references are recorded in `crates/osg-native-tools/delivery/native-tools.upstreams.lock.json`.
  FFmpeg source is available from <https://ffmpeg.org/releases/>; the downloaded package includes
  its license material.
- yt-dlp 2026.07.04 frozen binaries: GPL-3.0-or-later, with upstream license and third-party notices
  pinned by the native-tool catalog.
- Deno 2.9.5: MIT, with its license and notice asset pinned by the native-tool catalog.

## Downloadable ASR and speech packages

The Windows managed runtime notice index is
`crates/osg-engine-packages/delivery/windows-managed-runtime-notices.json`. Package archives retain
the exact `METADATA`, `LICENSE`, `COPYING`, `NOTICE`, and `dist-info/licenses` files installed by
each Python distribution. Model downloads are bound to immutable Hugging Face commit revisions.

Important model terms include:

- Parakeet TDT 0.6B v3 ONNX: CC-BY-4.0.
- Faster Whisper Large v3 and Large v3 Turbo conversions: MIT.
- Qwen3-ASR and Qwen3 ForcedAligner: Apache-2.0.
- Chatterbox code and model files: MIT.
- F5-TTS code: MIT; the default F5TTS_v1_Base model is CC-BY-NC-4.0 and is not licensed for
  commercial use. It is downloaded directly from the official immutable model revision.

## No implied relicensing

Third-party names, models, fonts, binaries, and data remain under their upstream terms. Nothing in
the repository MIT License changes those terms. When redistributing a packaged build, preserve this
file, the root `LICENSE`, the delivery catalogs, and all license/notice files carried by downloaded
packages.
