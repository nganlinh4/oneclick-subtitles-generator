# Third-party notices

OneClick Subtitles Generator is licensed under the MIT License. Its desktop shell and optional
downloadable components incorporate or interact with third-party software under their respective
terms. Exact versions and integrity hashes are pinned by `Cargo.lock`, `package-lock.json`, and the
delivery catalogs below.

## Desktop and web application

- Tauri and the Rust crates recorded in `Cargo.lock` retain their crate metadata and license files.
- React, Vite, and the npm packages recorded in `package-lock.json` retain their package license
  metadata.
- The WebView's icon font and its secondary web fonts are **bundled with the application**; none is
  fetched from a CDN at runtime, and the production CSP allows no font or stylesheet origin but the
  application itself. Each
  file is the exact `.woff2` the Google Fonts API served (immutable, versioned `fonts.gstatic.com`
  objects), pinned by source URL, size, and SHA-256 in `src/assets/fonts/fonts.manifest.json` and
  `promptdj-midi/assets/fonts/fonts.manifest.json`. Their licence texts are reproduced in
  [Licence texts for bundled web fonts](#licence-texts-for-bundled-web-fonts).
  - Material Symbols Rounded (font version 2.978, Google Fonts `v381`, variable axes FILL, GRAD,
    opsz, wght), Apache-2.0, Copyright 2026 Google LLC; upstream
    <https://github.com/google/material-design-icons>. File:
    `src/assets/fonts/material-symbols-rounded/material-symbols-rounded.woff2`.
  - JetBrains Mono (version 2.211, Google Fonts `v24`), SIL Open Font License 1.1, Copyright 2020
    The JetBrains Mono Project Authors (<https://github.com/JetBrains/JetBrainsMono>). Files:
    `src/assets/fonts/jetbrains-mono/jetbrains-mono-<subset>.woff2`.
  - Noto Sans (version 2.015, Google Fonts `v42`), SIL Open Font License 1.1, Copyright 2022 The
    Noto Project Authors (<https://github.com/notofonts/latin-greek-cyrillic>). Files:
    `src/assets/fonts/noto-sans/noto-sans-<subset>.woff2`.
  - Open Sans (version 3.003, Google Fonts `v44`), used by PromptDJ, SIL Open Font License 1.1,
    Copyright 2020 The Open Sans Project Authors (<https://github.com/googlefonts/opensans>). Files
    in `promptdj-midi/assets/fonts/open-sans/`: `open-sans-cyrillic-ext.woff2`,
    `open-sans-cyrillic.woff2`, `open-sans-greek-ext.woff2`, `open-sans-greek.woff2`,
    `open-sans-hebrew.woff2`, `open-sans-math.woff2`, `open-sans-symbols.woff2`,
    `open-sans-vietnamese.woff2`, `open-sans-latin-ext.woff2`, `open-sans-latin.woff2`.
- Google Sans Flex v22 is **bundled with the application** under SIL Open Font License 1.1.
  `crates/osg-engine-packages/delivery/ui-fonts.delivery.json` pins each `.woff2` subset, the OFL
  text, and the family NOTICE by size and SHA-256, and `apps/desktop/src-tauri/resources/ui-fonts`
  ships exactly those bytes, each file named by its SHA-256. Alongside the `fonts.gstatic.com`
  originals, this project also mirrors the same bytes on its own GitHub release
  `osg-runtime-bundles-v1`, so OSG redistributes the font files itself under OFL-1.1. The OFL text
  and the family NOTICE are bundled with the fonts, as OFL-1.1 requires, and are installed into the
  application's font store alongside them.

  It used to be fetched on first launch instead. That made the default subtitle font depend on the
  network: on a clean profile the download did not finish within the eight seconds startup waits,
  the font was declared unavailable, and the editor could not render a subtitle preview at all —
  and offline it never could. Bundling the reviewed bytes is what makes the default usable on a
  clean offline install. The delivery catalog is unchanged and still governs updates; the bundled
  copy is verified against the same SHA-256 as a downloaded one.

  The legacy embedded TTF remains retired; it is a different, larger file and is not what ships.
- The application does not bundle Product Sans.

### Native media decoding and encoding

Native rendering and playback call the H.264 and AAC **encoders**, and the video **decoder**, that
Windows Media Foundation provides as part of the operating system. This project ships no H.264
implementation of its own and redistributes no codec binary or FFmpeg build for rendering.

It does compile an AAC **decoder** into the application: source audio is decoded by `symphonia`,
whose `aac` and `isomp4` features are enabled in `crates/osg-audio/Cargo.toml`, and those crates are
redistributed in compiled form as recorded below. Media Foundation has no AAC decode path here. The
distinction is stated because a decoder shipped inside the binary and a decoder provided by the
operating system are not the same redistribution question.

- **Video and AAC audio encoding, and video decoding** go through Windows Media Foundation via the
  `windows` crate.
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
  its license material. Nothing in the native render or export path uses it: rendering encodes
  through Media Foundation and needs no FFmpeg installed at all. It is downloaded for the media
  acquisition and inspection paths only.
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
- gTTS 2.5.4: MIT, and the Google Gen AI Python SDK 2.17.0: Apache-2.0. They are delivered as the
  separate gTTS and Gemini TTS provider-runtime closures pinned in the provider-runtime lock.
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
- Vocos mel-24kHz, the vocoder the F5-TTS backend downloads alongside that model: MIT, pinned as
  `charactr/vocos-mel-24khz` in `crates/osg-speech/delivery/speech-upstreams.lock.json`.

## Downloadable voice-preview media

The Gemini voice-preview pack contains the 30 reviewed WAV samples formerly shipped under
`public/audio/voices`. It is distributed as the content-addressed archive recorded in
`crates/osg-engine-packages/delivery/voice-samples.delivery.json`. The samples remain subject to
their provider terms and are not relicensed by the repository MIT license.

## Open notice items

These are recorded observations, not conclusions. The root license is settled; these are the notice
gaps left to close before distribution.

- The published notice index
  `crates/osg-engine-packages/delivery/windows-managed-runtime-notices.json` lists seventeen
  components and does not yet include the Vocos vocoder named above. Correcting it means
  republishing that pool asset and refreshing `delivery/managed-delivery.checkpoint.json`, so the
  entry is recorded here in the meantime.
- The ASR and speech runtimes were not installed on the machine used to compile these notices, so
  their entries above are taken from the committed delivery catalogs rather than from delivered
  bytes.
- Where a delivered component retains no license file, the license named above is the upstream
  project's published term, not text read out of the payload. This applies to the downloadable
  FFmpeg/ffprobe build, whose GPL-3.0-or-later terms and configuration come from the reviewed
  vendor archive's own records rather than from bytes on this machine.

## Licence texts for bundled web fonts

JetBrains Mono, Noto Sans, and Open Sans are each distributed under the SIL Open Font License,
Version 1.1, with the copyright lines given above. The licence text is:

```text
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

Material Symbols Rounded is distributed under the Apache License, Version 2.0:

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```

## No implied relicensing

Third-party names, models, fonts, binaries, and data remain under their upstream terms. Nothing in
the repository MIT License changes those terms. When redistributing a packaged build, preserve this
file, the root `LICENSE`, the delivery catalogs, and all license/notice files carried by downloaded
packages.
