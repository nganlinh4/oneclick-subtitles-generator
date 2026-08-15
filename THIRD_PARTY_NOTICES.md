# Third-party notices

OneClick Subtitles Generator is licensed under the MIT License. Its desktop shell and optional
downloadable components incorporate or interact with third-party software under their respective
terms. Exact versions and integrity hashes are pinned by `Cargo.lock`, `package-lock.json`, and the
delivery catalogs below. The notice text that travels inside the downloadable video render runtime
is `licenses/DELIVERY-NOTICES.md`.

## Desktop and web application

- Tauri and the Rust crates recorded in `Cargo.lock` retain their crate metadata and license files.
- React, Vite, Remotion, and the npm packages recorded in `package-lock.json` retain their package
  license metadata. Remotion is licensed under its upstream license and is not considered part of
  this repository's MIT grant.
- Material Symbols are used under Apache-2.0. The application does not bundle Product Sans.
- Google Sans Flex v22 is installed on demand from the official Google Fonts distribution under
  SIL Open Font License 1.1. Exact source bytes, license text, and the content-addressed OSG fallback
  are recorded in `crates/osg-engine-packages/delivery/ui-fonts.delivery.json`; the legacy embedded
  TTF is retired and excluded from the application payload.

### Mozilla Public License 2.0 components

MPL-2.0 is a file-level copyleft license and is not covered by the repository MIT grant. The
following MPL-2.0 components are reached through the dependency graphs above. Each upstream project
carries its own `LICENSE` file in its published artifact.

- Rust crates pinned in `Cargo.lock`, each declaring `license = "MPL-2.0"` in its published
  `Cargo.toml`: `cssparser` 0.36.0, `cssparser-macros` 0.6.1, `dtoa-short` 0.3.5,
  `selectors` 0.36.1, and `option-ext` 0.2.0. The first four are pulled in through `dom_query`,
  a direct dependency of `osg-providers` and a transitive dependency of `tauri-utils` and `wry`;
  `option-ext` is pulled in through `dirs` and `dirs-sys`, used by `tauri`, `tauri-build`,
  `tauri-plugin-updater`, `tray-icon`, and `wry`.
- `mediabunny` 1.50.8 and the `@mediabunny/aac-encoder`, `@mediabunny/flac-encoder`, and
  `@mediabunny/mp3-encoder` 1.50.8 packages recorded in `package-lock.json`. These are not direct
  dependencies of this repository; they are non-development dependencies of `@remotion/media-utils`,
  `@remotion/studio`, `@remotion/timeline-utils`, and `@remotion/web-renderer`. Compiled
  `mediabunny` modules are also present inside the downloadable render runtime; see below.

## Downloadable native tools

- FFmpeg/ffprobe 8.1.2 Windows essentials build: GPL-3.0-or-later. The reviewed artifact and source
  references are recorded in `crates/osg-native-tools/delivery/native-tools.upstreams.lock.json`.
  FFmpeg source is available from <https://ffmpeg.org/releases/>; the downloaded package includes
  its license material. This build is separate from, and configured differently to, the FFmpeg
  binaries inside the render runtime described below.
- yt-dlp 2026.07.04 frozen binaries: GPL-3.0-or-later, with upstream license and third-party notices
  pinned by the native-tool catalog.
- Deno 2.9.5: MIT, with its license and notice asset pinned by the native-tool catalog.

## Downloadable video render runtime

The Windows render runtime is catalogued in `video-renderer/delivery/remotion-runtime.delivery.json`.
It is a single content-addressed archive re-hosted on this project's own GitHub release rather than
fetched from each upstream at install time, so this repository redistributes every component listed
below. The archive carries `licenses/DELIVERY-NOTICES.md` and an identical copy at
`runtime/THIRD_PARTY_NOTICES.md`.

- Node.js 24.19.0: MIT. The Node.js project's own `LICENSE` file is the authoritative record of the
  notices for the third-party components Node.js bundles. The runtime ships `runtime/bin/node.exe`
  only; that license text is not retained beside it.
- Chrome for Testing 149.0.7790.0 (`runtime/browser/chrome-win64`): the Chromium project's licensing
  plus Google's Chrome for Testing terms. The payload's `ABOUT` file records "Copyright 2026 Google
  LLC" and directs readers to `chrome://credits` and `chrome://terms`. No standalone license,
  credits, or notice file is retained in the browser directory, and the credits resource was not
  locatable in the shipped `.pak` files by inspection, so the per-component Chromium notices are
  reachable only by launching the browser at `chrome://credits`.
- Remotion 4.0.507: **not open source.** Its `package.json` declares
  `"license": "SEE LICENSE IN LICENSE.md"`, and the terms are the Remotion License, reproduced at
  `node_modules/remotion/LICENSE.md` in this repository and at
  `runtime/renderer/node_modules/remotion/LICENSE.md` and
  `runtime/renderer/node_modules/@remotion/renderer/LICENSE.md` inside the delivered archive. The
  license is tiered by company size: a Free License covers individuals, non-profits, evaluation, and
  for-profit organizations with up to 3 employees, and a Company License is required above that
  threshold. It also forbids relicensing or reselling a derivative of Remotion.
- `@remotion/compositor-win32-x64-msvc` 4.0.507 ships its own `ffmpeg.exe`, `ffprobe.exe`,
  `remotion.exe`, and FFmpeg shared libraries (`avcodec-60/61`, `avformat-60/61`, `avutil-58/59`,
  `avfilter-9/10`, `avdevice-60/61`, `swresample-4/5`, `swscale-7/8`). `ffmpeg.exe -version` reports
  FFmpeg **n7.1**, "built with gcc 10-win32 (GCC) 20220113", configured with **`--enable-gpl`**
  together with `--enable-libx264`, `--enable-libx265`, `--enable-libfdk-aac`, `--enable-libvpx`,
  `--enable-libmp3lame`, `--enable-libopus`, `--enable-libdav1d`, `--enable-libaom`,
  `--enable-libzimg`, and `--enable-zlib`. x264 and x265 are GPL-2.0-or-later projects offered under
  commercial licenses by their vendors; Fraunhofer FDK AAC is distributed under the Fraunhofer FDK
  AAC Codec Library for Android license, which is not an OSI-approved license. No separate
  `libx264`, `libx265`, or `fdk-aac` DLL is present, so these encoders are linked into the FFmpeg
  libraries. No FFmpeg, x264, x265, or FDK AAC license, `COPYING`, or notice file is retained
  anywhere in the delivered archive, and the npm package itself contains no license file.
- libvpx ships as a separate `libvpx-1.dll` in the same directory; libvpx is distributed by the
  WebM Project under a BSD-3-Clause-style license with an additional patent grant.
- Toolchain runtime libraries redistributed alongside those binaries, with no license file retained
  in the payload:
  - `libgcc_s_seh-1.dll`, `libstdc++-6.dll`, and `libssp-0.dll` — GCC runtime support libraries
    matching the "gcc 10-win32" toolchain named in the FFmpeg banner. Upstream, GCC runtime
    libraries are distributed under GPL-3.0-or-later with the GCC Runtime Library Exception
    (<https://www.gnu.org/licenses/gcc-exception-3.1.html>). These three DLLs carry no Windows
    version resource, so their exact upstream build was not identifiable from the files themselves.
  - `libwinpthread-1.dll` — Windows version resource records "MingW-W64 Project. All rights
    reserved." and the description "POSIX WinThreads for Windows"; the MinGW-w64 winpthreads
    library is distributed under its own permissive MinGW-w64 license terms.
  - `zlib1.dll` — version resource records product "zlib", description "zlib data compression
    library", file version 2.2.11. zlib is distributed under the zlib license.
  - `msvcr100.dll` — version resource records "Microsoft Corporation", "Microsoft® Visual Studio®
    2010", "Microsoft® C Runtime Library", file version 10.00.40219.473. This is a Microsoft Visual
    C++ 2010 runtime redistributable and remains subject to Microsoft's redistribution terms.
- `mediabunny` 1.50.8 and `@mediabunny/aac-encoder` 1.50.8 (MPL-2.0) are compiled into the render
  bundle rather than shipped as packages: `runtime/bundle/399.bundle.js` embeds 34 `mediabunny`
  source modules and `runtime/bundle/208.bundle.js` embeds the AAC encoder bundle, as recorded in
  the adjacent `.map` files. No MPL-2.0 notice or source reference for them is retained in the
  delivered archive.
- Inter at Google Fonts revision `038b637da7b3fd956a4ed93ffc607c3d5e4ce172`: SIL Open Font License
  1.1. This is the one delivered component whose license text is retained in the payload, at
  `runtime/bundle/fonts/OFL.txt`, and declared in `runtime/bundle/fonts/font-pack.json`.
- The remaining production npm closure inside `runtime/renderer/node_modules` (React, React DOM,
  scheduler, `ws`, `execa`, `cross-spawn`, and related packages) retains 31 per-package license
  files, each inventoried with its size and SHA-256 in the delivery manifest.

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

- The render runtime archive redistributes GPL-configured FFmpeg binaries with x264, x265, and
  FDK AAC enabled, plus GCC runtime, MinGW-w64, zlib, and Microsoft Visual C++ 2010 runtime
  libraries, without retaining any of those projects' license or notice files and without a
  corresponding source offer.
- MPL-2.0 `mediabunny` code is redistributed in compiled form inside the render bundle with no
  accompanying notice or source reference.
- Upstream provenance for the delivered Node.js and Chrome for Testing binaries is asserted in the
  notice text but is not pinned by URL and hash in any committed catalog; only the re-hosted
  aggregate archive is hash-pinned.
- The ASR and speech runtimes were not installed on the machine used to compile these notices, so
  their entries above are taken from the committed delivery catalogs rather than from delivered
  bytes.
- Where a delivered component retains no license file, the license named above is the upstream
  project's published term, not text read out of the payload. This applies to FFmpeg, x264, x265,
  FDK AAC, libvpx, the GCC runtime libraries, MinGW-w64 winpthreads, zlib, the Microsoft Visual C++
  2010 runtime, Node.js, and Chromium. The versions, build configuration, and file identities backing
  those entries were read directly from the installed render runtime.

## No implied relicensing

Third-party names, models, fonts, binaries, and data remain under their upstream terms. Nothing in
the repository MIT License changes those terms. When redistributing a packaged build, preserve this
file, `licenses/DELIVERY-NOTICES.md`, the root `LICENSE`, the delivery catalogs, and all
license/notice files carried by downloaded packages.
