# OSG Windows 1.0 release validation

OSG Windows 1.0 replaces the legacy Node/Electron application as the repository's primary
product. It must not be published, tagged, or merged to `main` merely because compilation and
unit tests pass. Release approval requires the real installed Windows executable to complete the
feature matrix below on a clean Windows profile.

The pre-release version is `1.0.0-rc.1`. The final `1.0.0` version is reserved for the approved
official release. Legacy releases used versions through `2.6.1`; therefore SemVer considers them
newer than `1.0.0`. Moving from the legacy application to OSG Windows 1.0 is a one-time manual
migration. Automatic signed updates begin with the OSG Windows 1.x release line.

## Release topology

- Official product name: **OSG Windows**.
- Supported release target: Windows x64.
- Official GitHub tag: `v1.0.0` only after this document is signed off.
- Signed updater metadata: `releases/latest/download/latest.json`.
- Runtime/model/font assets: immutable, content-addressed assets under
  `osg-runtime-bundles-v1`, downloaded on demand and never embedded merely to make a test pass.
- Linux and macOS are not supported releases because no maintained real-device validation
  environment is available. Contributions that reproduce, package, sign, and test those targets
  are welcome through pull requests.
- The legacy Node/Electron edition remains accessible through Git history/tags; it is not shipped
  beside the new host or silently used as a fallback.

## Test rules

- Run destructive, installer, updater, window, focus, restart, browser-OAuth, and clean-profile
  tests on isolated GitHub Windows runners or a dedicated disposable Windows VM—not on the
  developer's active desktop.
- Never read or print credential values. Real Gemini tests may load configured CI secrets or the
  developer-provided `.env` only through the credential import boundary.
- For a bounded provider smoke outside the UI, use `npm run test:gemini-catalog -- --live
  --env-file .env --audio-file <fixture.wav> --model gemini-3.1-flash-lite`; this reads the key
  without printing it and avoids exercising every paid model during routine validation.
- Capture bounded structured application logs, screenshots, command exit status, and output hashes.
- A cancelled operation must produce one cancelled terminal state and leave no partial published
  asset. A failed operation must expose a sanitized actionable error and remain retryable.
- Every on-demand package test starts without that package installed, verifies download and
  integrity, uses it in the same process, removes it, and verifies that a later operation reinstalls
  it without requiring an application restart.

## Automated gates

- [ ] Exact pinned Node/npm/Python/Rust/Tauri toolchains.
- [ ] Clean `npm ci` for root and desktop manifests; production dependency audit has zero findings.
- [ ] Full ESLint, Vitest, Python worker contracts, Rust format, strict Clippy, workspace tests.
- [ ] Visual freeze, frozen compiled CSS, i18n, model catalog, native-only production transport.
- [ ] Tauri handler/build/ACL/reachability contract.
- [ ] Managed-delivery checkpoint and remote read-back for every referenced pool asset.
- [ ] Windows runtime-package readiness and installer extraction/architecture/resource/signature
  checks.
- [ ] Four-target compile matrix remains green, without claiming runtime support for untested
  targets.
- [ ] Installed Windows EXE reaches `app.start`, managed UI-font readiness, and `app.ready` in order
  on a clean CI profile and remains responsive.
- [ ] Manual `installed-smoke` builds the current branch, validates its unsigned NSIS package, and
  installs/launches it on an isolated runner; `published-installed-smoke` separately downloads and
  verifies the signed immutable GitHub release artifact. A published tag is never used as evidence
  that the branch currently under review can be installed.

## Evidence ledger

Passing an individual row records evidence for that row only; it does not complete a combined
feature-matrix checkbox or approve the release.

| Date | Scope | Result | Evidence and follow-up |
| --- | --- | --- | --- |
| 2026-08-12 | Managed Remotion delivery | Pass | The published Windows package installed, resolved, launched, and removed over HTTPS. |
| 2026-08-12 | Real Remotion render | Pass | The managed Node/Chromium worker rendered 24 frames of a one-second 640×360 composition and produced a validated MP4. The test found and fixed Node's rejection of canonical `\\?\` Windows worker paths. |
| 2026-08-12 | Parakeet local ASR | Pass | A clean managed install launched the real worker, transcribed bounded 16 kHz WAV audio, shut down, and removed immediately in 1,169.83 seconds. The first run exposed 993 generated `.pyc` files; managed Python now uses `-B` and a narrow migration removes only legacy `runtime/**/__pycache__/*.pyc`. |
| 2026-08-12 | Faster-Whisper Turbo local ASR | Pass | The 6.75 GiB managed package loaded CTranslate2 on CUDA, returned nonempty text and segments with bounded timestamps from real 16 kHz speech, shut down, and removed immediately. The first constructor probe found CTranslate2 rejected canonical Windows `\\?\` model paths; ASR now normalizes only host-owned process/protocol paths. The retained-install post-fix lifecycle passed in 233.50 seconds. |
| 2026-08-12 | Faster-Whisper Large-v3 local ASR | Pass | A clean 8.12 GiB managed install loaded the distinct Large-v3 CTranslate2 model on CUDA, returned nonempty text and bounded segments from real speech, shut down, removed immediately, and left no package/archive residue in 1,025.71 seconds. |
| 2026-08-12 | Qwen3-ASR 0.6B local ASR | Pass | The 8.70 GiB managed package loaded the pinned 0.6B model and separately pinned forced aligner on CUDA, returned nonempty text and bounded segments, shut down, and removed immediately. The first run exposed PyTorch's dependency on a username-derived Inductor cache under a scrubbed environment; ASR workers now receive process-private Torch/Numba caches and a fixed non-identifying worker identity. The retained-install post-fix lifecycle passed in 405.41 seconds. |
| 2026-08-12 | Qwen3-ASR 1.7B local ASR | Pass | A clean 9.14 GiB download published an 11.33 GiB receipt-verified package, loaded the pinned 1.7B model and forced aligner on CUDA, returned nonempty text and bounded segments from real speech, shut down, removed immediately, and left zero download/staging/trash residue in 1,892.07 seconds. |
| 2026-08-12 | Slim network speech runtimes | Pass | Reproducible, provider-specific Windows runtimes now retain exact CPython/wheel identities and license files while excluding build-only pip/setuptools and all GPU dependencies. Edge downloads 11.5 MB/installs 35.5 MB, gTTS 11.3 MB/34.3 MB, and Gemini 20.2 MB/61.9 MB; two clean builds were byte-identical and the published assets were read back by length and SHA-256. |
| 2026-08-12 | Edge TTS | Pass | The new slim package completed a clean managed install, real provider synthesis, artifact validation, shutdown, immediate removal, and zero download/staging/trash residue in 16.14 seconds. |
| 2026-08-12 | gTTS | Pass | The 11.3 MB slim package completed a clean managed install, real provider synthesis, MP3 artifact validation, shutdown, immediate removal, and zero installed-package residue in 11.81 seconds. |
| 2026-08-12 | Gemini Live narration | Pass | The 20.2 MB slim package imported the configured key without printing it, completed a real `gemini-3.1-flash-live-preview` audio turn, validated the WAV artifact, shut down, and removed immediately in 31.75 seconds. |
| 2026-08-12 | F5-TTS | Pass | The receipt-verified 6.47 GiB managed package loaded on CUDA, synthesized a cloned-voice WAV from a bounded local reference, validated the artifact, shut down, and removed immediately in 292.74 seconds. Two real compatibility defects were fixed: Windows extended-length paths are normalized only at the supervised process boundary, and pinned TorchAudio 2.11 file I/O is replaced by bounded SoundFile decoding while tensor resampling remains managed. F5's model remains non-commercial under CC-BY-NC-4.0. |
| 2026-08-12 | Chatterbox | Pass | The 11.15 GiB receipt-verified managed package loaded on CUDA, synthesized cloned-voice WAV audio, validated the artifact, shut down, and removed immediately. The first successful synthesis generated 52 Librosa/Numba cache files inside the runtime and removal correctly failed closed; workers now use a process-private temporary Numba cache, and a narrow migration removes only recognized `runtime/**/__pycache__/*.{pyc,nbc,nbi}` when no other undeclared file exists. The post-fix retained-install lifecycle passed in 403.58 seconds. |
| 2026-08-12 | Gemini media input | Pass with model constraint | The bounded live audio probe succeeds with `gemini-3.1-flash-lite`; the same request returned provider HTTP 500 twice with `gemini-3.5-flash-lite`, so 3.1 remains the candidate default pending recheck. |

## Real installed-EXE feature matrix

### First launch, migration, persistence

- [ ] Clean install, launch, close, relaunch, uninstall, and reinstall.
- [ ] Google Sans Flex first-use download, offline reuse, corruption repair, and immediate removal.
- [ ] Legacy folder import through the documented keyboard action: preferences, credentials,
  projects, subtitles, and supported media; repeated import is idempotent.
- [ ] Settings, projects, media, job recovery, undo/redo, and active editor state survive restart.
- [ ] Bounded log rotation contains phase/timing/error codes without secrets or native paths.

### Media input and download

- [ ] Local audio/video picker, drag-and-drop, playback, seek, volume, waveform, thumbnail, probe,
  compatibility transcode, exact clip, and audio extraction.
- [ ] YouTube URL inspection, metadata/thumbnail, subtitle-only, media-only, media plus uploaded SRT,
  automatic transcription, cancellation, retry, and user-selected export destination.
- [ ] FFmpeg/FFprobe, yt-dlp, and Deno install in parallel on demand, activate immediately, show
  independent progress, uninstall immediately when idle, and reinstall automatically when needed.
- [ ] A controlled yt-dlp operation failure performs one throttled verified update, hot-activates
  it, and never uses `yt-dlp -U` or retries the user operation invisibly.

### Credentials and providers

- [ ] Gemini keys import into the operating-system credential store, rotate across multiple keys,
  cool down on quota failures, and never reappear in browser storage/logs.
- [ ] YouTube OAuth uses native PKCE/loopback callback and native provider calls.
- [ ] Genius search and YouTube search/history return only native image capabilities; persisted
  history rehydrates thumbnails after restart.
- [ ] Gemini ordinary model, image model, and Live/Lyria paths each complete one real bounded call.

### Subtitle generation and editing

- [ ] Gemini lite transcription from downloaded video completes with phase/timing logs and never
  appears as a render job.
- [ ] Recheck `gemini-3.5-flash-lite` audio before publication. On 2026-08-12 the same minimal WAV
  request returned provider HTTP 500 twice while `gemini-3.1-flash-lite` succeeded, so 3.1 remains
  the release-candidate media default even though Google's model page advertises 3.5 audio input.
- [ ] Local ASR: Parakeet, Faster-Whisper Turbo, Faster-Whisper Large-v3, Qwen3-ASR 1.7B, and
  Qwen3-ASR 0.6B install/use/cancel/remove independently.
- [ ] Language selection, segmentation strategies, transcription rules, retries, progressive
  results, SRT import/export, translation, grouping, analysis, and timing preservation.
- [ ] Text edit, insert, delete, split, merge, range actions, drag timing, checkpoints, save barrier,
  255-edge durable undo/redo, restart recovery, and backpressure failure recovery.

### Narration and audio

- [ ] F5-TTS and Chatterbox install/use/cancel/remove; reference import/recording, recognition,
  voice conversion, retry, speed edit, playback, download, and alignment.
- [ ] Edge TTS, gTTS, and Gemini narration generate, retry, align, export, and restore after restart.
- [ ] Batch failure short-circuits safely; concurrent cancellation does not terminate unrelated
  active speech work.
- [ ] F5's `CC-BY-NC-4.0` model notice is visible before installation and remains excluded from any
  commercial-support claim.

### Rendering, images, and music

- [ ] Remotion runtime installs on demand and renders the frozen composition with local fonts,
  source media, subtitles, narration, progress, cancellation, recovery, preview, and explicit
  export.
- [ ] Background image generation accepts supported inputs, stores opaque assets, and exports them.
- [ ] PromptDJ/Lyria starts, updates prompts, streams PCM, stops, closes, and recovers cleanly from
  provider failure.

### Signed application update

- [ ] Startup performs one non-blocking signed update check after `app.ready`; offline/rate-limited
  checks do not delay launch or show repeated errors.
- [ ] About shows the same cached result and supports a manual recheck.
- [ ] User acceptance starts a signed bounded download with progress and cancellation.
- [ ] The updater rejects a modified installer, wrong key, downgraded/equal version, malformed
  metadata, non-HTTPS URL, wrong architecture, and interrupted download.
- [ ] Successful installation preserves projects/settings/packages, relaunches once, reports the new
  version, and does not repeat the update prompt.

## Publication sequence

1. Complete and attach evidence for every applicable Windows checkbox.
2. Build `1.0.0` from a clean commit using the external updater-signing key.
3. Validate the installer and `.sig`, generate immutable `latest.json`, and test them from a draft
   GitHub release on an isolated Windows runner.
4. Replace `main` with the reviewed Tauri history only after the draft artifact passes.
5. Publish one official release titled **OSG Windows 1.0.0** and mark it Latest.
6. Verify the installed release's startup update check against the public GitHub endpoint.
