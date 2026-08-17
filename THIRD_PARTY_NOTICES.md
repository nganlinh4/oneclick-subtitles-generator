# Third-party notices

OneClick Subtitles Generator is licensed under the MIT License. Its desktop shell and optional
downloadable components incorporate or interact with third-party software under their respective
terms. Exact versions and integrity hashes are pinned by `Cargo.lock`, `package-lock.json`, and the
delivery catalogs below.

## Desktop and web application

- Tauri and the Rust crates recorded in `Cargo.lock` retain their crate metadata and license files.
- React, Vite, and the npm packages recorded in `package-lock.json` retain their package license
  metadata.
- Material Symbols are used under Apache-2.0. The application does not bundle Product Sans.
- Google Sans Flex v22 is installed on demand from the official Google Fonts distribution under
  SIL Open Font License 1.1. Exact source bytes, license text, and the content-addressed OSG fallback
  are recorded in `crates/osg-engine-packages/delivery/ui-fonts.delivery.json`; the legacy embedded
  TTF is retired and excluded from the application payload.

### Native media decoding and encoding

The application decodes and encodes media without redistributing any codec binary.

- **Video and AAC audio encoding, and video decoding**, use Windows Media Foundation through the
  `windows` crate. The H.264 and AAC implementations are part of the operating system and are
  licensed by Microsoft to the user running the machine. This repository redistributes no codec, no
  FFmpeg build, and no downloaded media tool.
- **Source audio decoding** uses `symphonia` and its sub-crates, pinned in `Cargo.lock` and licensed
  MPL-2.0; see the section below.
- **Opus audio decoding** uses `symphonia-adapter-libopus` 0.2.9 (MIT OR Apache-2.0), which wraps
  the reference libopus through `opusic-sys` 0.7.5 (BSD-3-Clause). libopus itself is BSD-3-Clause
  and is compiled from the vendored source that Cargo checksums, so no binary is fetched and no
  system library is trusted. Opus is not an optional case: audio downloaded with yt-dlp frequently
  arrives as Opus in a WebM container, and `symphonia` has no Opus decoder of its own.

### Mozilla Public License 2.0 components

MPL-2.0 is a file-level copyleft license and is not covered by the repository MIT grant. The
following MPL-2.0 components are reached through the dependency graphs above. Each upstream project
carries its own `LICENSE` file in its published artifact.

- Rust crates pinned in `Cargo.lock`, each declaring `license = "MPL-2.0"` in its published
  `Cargo.toml`: `cssparser` 0.36.0, `cssparser-macros` 0.6.1, `dtoa-short` 0.3.5,
  `selectors` 0.36.1, and `option-ext` 0.2.0.
- `symphonia` 0.5.5 and its sub-crates — `symphonia-core`, `symphonia-metadata`,
  `symphonia-utils-xiph`, `symphonia-bundle-flac`, `symphonia-bundle-mp3`, `symphonia-codec-aac`,
  `symphonia-codec-pcm`, `symphonia-codec-vorbis`, `symphonia-format-isomp4`,
  `symphonia-format-mkv`, `symphonia-format-ogg` and `symphonia-format-riff` — reached as direct
  dependencies of `osg-audio`. They are redistributed in compiled form inside the application
  binary; MPL-2.0 requires the source of these files to remain available, which it is at their
  published crates.io versions. The first four are pulled in through `dom_query`,
  a direct dependency of `osg-providers` and a transitive dependency of `tauri-utils` and `wry`;
  `option-ext` is pulled in through `dirs` and `dirs-sys`, used by `tauri`, `tauri-build`,
  `tauri-plugin-updater`, `tray-icon`, and `wry`.

## Downloadable native tools

- FFmpeg/ffprobe 8.1.2 Windows essentials build: GPL-3.0-or-later. The reviewed artifact and source
  references are recorded in `crates/osg-native-tools/delivery/native-tools.upstreams.lock.json`.
  FFmpeg source is available from <https://ffmpeg.org/releases/>; the downloaded package includes
  its license material. This build is separate from, and configured differently to, the FFmpeg
  binaries used by the native export.
- yt-dlp 2026.07.04 frozen binaries: GPL-3.0-or-later, with upstream license and third-party notices
  pinned by the native-tool catalog.
- Deno 2.9.5: MIT, with its license and notice asset pinned by the native-tool catalog.

## Downloadable ASR and speech packages

The Windows managed runtime notice index is
`crates/osg-engine-packages/delivery/windows-managed-runtime-notices.json`. Package archives retain
the exact `METADATA`, `LICENSE`, `COPYING`, `NOTICE`, and `dist-info/licenses` files installed by
each Python distribution. Model downloads are bound to immutable Hugging Face commit revisions.
The minimal Edge TTS, gTTS, and Gemini provider closures are separately bound by
`crates/osg-speech/delivery/provider-runtime-windows.lock.json`; their generated archives also
carry a package-specific `PROVIDER_RUNTIME_NOTICES.json` and do not contain the local GPU stack.

Important runtime terms include:

- CPython 3.11.15: Python-2.0. It is delivered as an `astral-sh/python-build-standalone` release
  `20260807` build. That distribution is itself licensed MPL-2.0, and
  `crates/osg-speech/delivery/speech-upstreams.lock.json` records both the license URL
  (<https://github.com/astral-sh/python-build-standalone/blob/20260807/LICENSE>) and
  `"thirdPartyNoticesRequired": true`, reflecting the many third-party components CPython builds
  bundle (OpenSSL, SQLite, libffi, and others), whose notices are retained inside the archive.
- PyTorch and TorchAudio 2.11.0+cu128: BSD-3-Clause, from <https://download.pytorch.org/whl/cu128>.
- NVIDIA CUDA runtime libraries redistributed by the PyTorch wheels, CUDA 12.8: these are not open
  source and remain governed by the NVIDIA CUDA Toolkit EULA, including its redistribution terms
  (<https://docs.nvidia.com/cuda/eula/>).
- ONNX Runtime GPU 1.24.4, faster-whisper 1.2.1, and onnx-asr 0.11.0: MIT.
- Edge TTS 7.2.8: **LGPL-3.0-only**, a copyleft license distinct from the permissive licenses
  elsewhere in the speech closure. It is delivered as the `edge_tts-7.2.8-py3-none-any.whl` artifact
  pinned in the provider-runtime lock.
- certifi 2026.7.22: MPL-2.0, pinned as `certifi-2026.7.22-py3-none-any.whl` and included in the
  Edge TTS provider runtime closure.
- The remaining provider-runtime wheels are individually license-tagged in the same lock file,
  predominantly Apache-2.0 and MIT.

Important model terms include:

- Parakeet TDT 0.6B v3 ONNX: CC-BY-4.0.
- Faster Whisper Large v3 and Large v3 Turbo conversions: MIT.
- Qwen3-ASR and Qwen3 ForcedAligner: Apache-2.0.
- Chatterbox code and model files: MIT.
- F5-TTS code: MIT; the default F5TTS_v1_Base model is CC-BY-NC-4.0 and is not licensed for
  commercial use. It is downloaded directly from the official immutable model revision.

## Downloadable voice-preview media

The Gemini voice-preview pack contains the 30 reviewed WAV samples formerly shipped under
`public/audio/voices`. It is distributed as the content-addressed archive recorded in
`crates/osg-engine-packages/delivery/voice-samples.delivery.json`. The samples remain subject to
their provider terms and are not relicensed by the repository MIT license.

## Open notice items

These are recorded observations, not conclusions. They are listed so the owner can resolve them
before distribution, alongside the outstanding root license and notice-policy decision.

- The ASR and speech runtimes were not installed on the machine used to compile these notices, so
  their entries above are taken from the committed delivery catalogs rather than from delivered
  bytes.
- Where a delivered component retains no license file, the license named above is the upstream
  project's published term, not text read out of the payload. This applies to the downloadable
  FFmpeg/ffprobe build, whose GPL-3.0-or-later terms and configuration come from the reviewed
  vendor archive's own records rather than from bytes on this machine.

## No implied relicensing

Third-party names, models, fonts, binaries, and data remain under their upstream terms. Nothing in
the repository MIT License changes those terms. When redistributing a packaged build, preserve this
file, the root `LICENSE`, the delivery catalogs, and all license/notice files carried by downloaded
packages.
