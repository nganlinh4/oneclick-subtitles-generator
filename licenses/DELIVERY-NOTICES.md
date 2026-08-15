# Managed Remotion runtime notices

This payload is downloaded separately from the application and is verified by exact file hashes. It
is re-hosted as a single content-addressed archive by the OneClick Subtitles Generator project, so
that project redistributes every component listed here. The catalog
`video-renderer/delivery/remotion-runtime.delivery.json` records the archive URL, archive hash,
installed file hashes, sizes, and runtime roles. No Product Sans file or alias is present.

## Runtime hosts

- Node.js 24.19.0 (`runtime/bin/node.exe`): MIT. Official archive from nodejs.org. The Node.js
  project's own `LICENSE` file is the authoritative record of the notices for the third-party
  components Node.js bundles; that license text is not retained beside the executable.
- Chrome for Testing 149.0.7790.0 (`runtime/browser/chrome-win64`): Chromium project licensing and
  Google's Chrome for Testing terms. Official archive from storage.googleapis.com. The payload's
  `ABOUT` file records "Copyright 2026 Google LLC" and points to `chrome://credits` and
  `chrome://terms`. No standalone license, credits, or notice file is retained in the browser
  directory, so the per-component Chromium notices are reachable only by launching the browser at
  `chrome://credits`.

## Remotion

- Remotion 4.0.507 is not open source. Its `package.json` declares
  `"license": "SEE LICENSE IN LICENSE.md"`. The full text is retained in this payload at
  `runtime/renderer/node_modules/remotion/LICENSE.md` and
  `runtime/renderer/node_modules/@remotion/renderer/LICENSE.md`. The Remotion License is tiered by
  company size: a Free License covers individuals, non-profits, evaluation use, and for-profit
  organizations with up to 3 employees, and a Company License is required above that threshold. It
  also forbids relicensing or reselling a derivative of Remotion.
- The production npm closure in `runtime/renderer/node_modules` (React, React DOM, scheduler, `ws`,
  `execa`, `cross-spawn`, and related packages) retains 31 per-package license files, each
  inventoried with its size and SHA-256 in the delivery manifest.

## Media binaries in `@remotion/compositor-win32-x64-msvc` 4.0.507

This package ships its own media binaries and shared libraries. `ffmpeg.exe -version` reports
FFmpeg **n7.1**, "built with gcc 10-win32 (GCC) 20220113", configured with **`--enable-gpl`**
together with `--enable-libx264`, `--enable-libx265`, `--enable-libfdk-aac`, `--enable-libvpx`,
`--enable-libmp3lame`, `--enable-libopus`, `--enable-libdav1d`, `--enable-libaom`,
`--enable-libzimg`, and `--enable-zlib`.

- `ffmpeg.exe`, `ffprobe.exe`, `remotion.exe`, and the FFmpeg shared libraries `avcodec-60/61`,
  `avformat-60/61`, `avutil-58/59`, `avfilter-9/10`, `avdevice-60/61`, `swresample-4/5`, and
  `swscale-7/8`. FFmpeg is distributed under LGPL-2.1-or-later, or GPL-2.0-or-later when built with
  `--enable-gpl` as this build is. Source is available from <https://ffmpeg.org/releases/>.
- x264 and x265 are enabled encoders. Both are GPL-2.0-or-later projects that their vendors also
  offer under separate commercial licenses.
- Fraunhofer FDK AAC is an enabled encoder. It is distributed under the Fraunhofer FDK AAC Codec
  Library for Android license, which is not an OSI-approved license.
- No separate `libx264`, `libx265`, or `fdk-aac` DLL is present, so these encoders are linked into
  the FFmpeg libraries above.
- `libvpx-1.dll`: libvpx, distributed by the WebM Project under a BSD-3-Clause-style license with an
  additional patent grant.

No FFmpeg, x264, x265, or FDK AAC license, `COPYING`, or notice file is present in this payload; the
upstream npm package contains no license file of its own.

## Toolchain runtime libraries

Redistributed beside the media binaries, with no license file retained in this payload:

- `libgcc_s_seh-1.dll`, `libstdc++-6.dll`, `libssp-0.dll`: GCC runtime support libraries matching
  the "gcc 10-win32" toolchain named in the FFmpeg banner. Upstream, GCC runtime libraries are
  distributed under GPL-3.0-or-later with the GCC Runtime Library Exception
  (<https://www.gnu.org/licenses/gcc-exception-3.1.html>). These files carry no Windows version
  resource, so their exact upstream build is not identifiable from the files themselves.
- `libwinpthread-1.dll`: version resource records "MingW-W64 Project. All rights reserved." and the
  description "POSIX WinThreads for Windows". MinGW-w64 winpthreads is distributed under its own
  permissive MinGW-w64 license terms.
- `zlib1.dll`: version resource records product "zlib", description "zlib data compression library",
  file version 2.2.11. zlib is distributed under the zlib license.
- `msvcr100.dll`: version resource records "Microsoft Corporation", "Microsoft® Visual Studio® 2010",
  "Microsoft® C Runtime Library", file version 10.00.40219.473. This is a Microsoft Visual C++ 2010
  runtime redistributable and remains subject to Microsoft's redistribution terms.

## Compiled bundle contents

- `mediabunny` 1.50.8 and `@mediabunny/aac-encoder` 1.50.8 are MPL-2.0 and are compiled into the
  render bundle rather than shipped as packages. `runtime/bundle/399.bundle.js` embeds 34
  `mediabunny` source modules and `runtime/bundle/208.bundle.js` embeds the AAC encoder bundle, as
  recorded in the adjacent `.map` files. They reach the bundle as non-development dependencies of
  `@remotion/media-utils`, `@remotion/studio`, `@remotion/timeline-utils`, and
  `@remotion/web-renderer`. No MPL-2.0 notice or source reference for them is retained here.

## Fonts

- Inter at Google Fonts revision `038b637da7b3fd956a4ed93ffc607c3d5e4ce172`: SIL Open Font License
  1.1. The license text is retained at `runtime/bundle/fonts/OFL.txt` and declared in
  `runtime/bundle/fonts/font-pack.json`.

## No implied relicensing

Every component above remains under its upstream terms. Nothing in the OneClick Subtitles Generator
license changes those terms. When redistributing this payload, preserve this file and every
license and notice file carried inside it.
