# OSG Windows 1.0 release validation

## Current candidate: September 2026

Owner direction (2026-09-18): after validating the separate native update channel, publish
**OSG 1.0.0 as non-Latest** from the native branch. This supersedes the earlier draft-only limit.
Do not merge into `main`, change the default branch, or change GitHub Latest. Legacy batch users
still consume `main` and `releases/latest/download/OSG_installer_Windows.bat`.

`rewrite/tauri-rust` is the canonical application branch. Legacy `main` is not a visual or
functional acceptance baseline. The owner approved the current branch's intentional visual
improvements on 2026-09-17; preserve that UI rather than reverting it to the original port.

### Published native candidate

The versioned application release contains only its installer. Signatures and signed package
receipts live on `osg-runtime-bundles-v1`, under
`OSG-<version>-windows-x64-<installer-sha256>.exe` plus their respective sidecar suffixes.
Archived updater manifests and checksums use the same version/hash prefix. Never overwrite pool
assets. The live manifest is committed atomically on the isolated `app-update-feed` branch.

The owner explicitly authorized replacing the initial 1.0.0 installer and retiring its old
release-based channel before user adoption. This is a one-time pre-adoption replacement, not a
policy permitting future same-version binary replacement. Older local copies must be reinstalled.
The following receipts describe the replacement unless explicitly marked historical.

- Release: [OSG 1.0.0](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/tag/v1.0.0),
  source `93ef21d767c0009c59ac9a47e64fcfbcfb8c60d0`, published non-Latest.
- Installer: `OSG-1.0.0-windows-x64-setup.exe`, 7,414,227 bytes;
  SHA-256 `3e7d2ad68672bcdb80c79c94206ded0c7be6e3c96d97ecc217f72c685eba0930`.
- [Clean installed workflow](https://github.com/nganlinh4/oneclick-subtitles-generator/actions/runs/35309116308):
  passed on this exact source. Production install, relaunch/reinstall, media download/import,
  runtime tools, edit/undo/redo and persistence; 11/11 packaged resources verified.
- [Signed updater workflow](https://github.com/nganlinh4/oneclick-subtitles-generator/actions/runs/35299220479):
  historical PASS on `f18cb71f`. Fixture update 1.0.0 → 1.0.1, restart and persistence; About
  controls screenshot reviewed. The fixture 1.0.1 is not published. This migration changes the
  endpoint, not the updater implementation or signing key.
- The public channel manifest and installer were downloaded without authentication and matched
  the verified local hashes. Manifest SHA-256:
  `76edaae4de750db2a5e636762a2822db8596407bf1ecc37dffeb1c8796e0173e`.
  Metadata-only feed commit: `e5450ae094873d59edb42ee751ed760d06239daa`.
- [Published replacement workflow](https://github.com/nganlinh4/oneclick-subtitles-generator/actions/runs/35310417910):
  PASS. The public replacement installer matched the hash above and its production startup check
  against the feed branch returned `current`, version `1.0.0`. The obsolete `osg-native-stable`
  release and tag were then deleted. Its metadata remains archived in the bundles pool.
- Legacy Latest remains `v2.6.1`; default branch remains `main`, at
  `48c8e988f3c771021c090702e2ac1ab5aa2f40f1`.
- The installer has a Tauri updater signature, not a Windows Authenticode publisher signature.
  Hardware/provider limitations below remain; this is not universal feature or hardware certification.

The August evidence below is historical, not certification of the September candidate. In
particular, Remotion results describe a removed implementation, and the UI font now ships in
the installer. No historical checked box approves a different commit's installer.

Current source candidate before release-preparation edits: `28b2495b`. The September 15 hidden
native-app audit covered settings/scaling, media playback, subtitle presets, real Gemini
translation and video analysis, document generation, gTTS narration and decoded native export.
It did not certify the production installer, actual fullscreen, or every downloadable engine.
Its local evidence index is `artifacts/ui-audit-2026-09-15/README.md`; preserve a sanitized copy
as release evidence before development-cache retention removes the underlying captures.

### Installer validation without a local VM

Use the existing GitHub-hosted Windows jobs. They install and uninstall on a disposable runner,
not the user's working PC. No Windows desktop control or live-data relocation is necessary locally.
After committing and pushing the reviewed candidate branch, run:

```powershell
gh workflow run rewrite-ci.yml --ref rewrite/tauri-rust -f job=full
gh workflow run rewrite-ci.yml --ref rewrite/tauri-rust -f job=installed-smoke
gh workflow run rewrite-ci.yml --ref rewrite/tauri-rust -f job=signed-updater-smoke
```

Record the resolved commit SHA for each run and download its artifacts. A queued job, successful
compile, or successful artifact download is not a passed installed workflow. Inspect screenshots,
structured results and logs; fix failures and repeat against the new commit. Do not silently run
the older remote branch or treat the compile-only macOS/Linux matrix as runtime certification.
Standard hosted Windows runners are not a substitute for representative GPU/hardware testing:
retain the local native-render evidence and report that limitation separately.

Measured on 2026-09-17: hosted Windows run `35195158987` rejected both GPU export tests at
`D3d11Device`, HRESULT `0x887A0004` (`DXGI_ERROR_UNSUPPORTED`). The same three desktop export
tests and the complete Rust workspace (including the 25-case native parity suite) pass on the
local Windows GPU. Do not replace those failures with a software fallback or describe the
hosted run as green. Microsoft documents that WARP does not support video encode/decode:
https://learn.microsoft.com/en-us/windows/win32/direct3d11/direct3d-11-1-features.
The hosted installer/update jobs and local GPU checks provide different evidence; neither alone
certifies all hardware. Full hosted matrix remains red until its hardware requirements are met.

The updater secrets already exist in repository Actions settings (names checked 2026-09-17).
Their presence is not proof of a valid matching key: the signed-updater job must verify it.
Updater signatures are distinct from Windows Authenticode publisher signatures.

### Release-preparation acceptance

- [ ] Final candidate committed and pushed; installed and signed-updater evidence reviewed.
  Record full-matrix hardware failures separately; do not label them passed.
- [ ] Production installer extracted and checked; no automation-only features in the shipment.
- [ ] Current screenshots/results reviewed, with failed and untested cases explicitly recorded.
- [ ] README in both languages, notices, migration instructions and release notes match shipment.
- [ ] Release assets, signed receipts, updater manifest and SHA-256 checksums refer to the same build.
- [ ] Production publication explicitly authorized; native release and channel explicitly non-Latest.

Do not fetch a private draft with an unauthenticated production updater and expect it to work.
Use authenticated artifact retrieval for draft inspection and the isolated signed-updater fixture
for pre-publication lifecycle testing; verify the public production endpoint after publication.

OSG Windows 1.0 replaces the legacy Node/Electron application as the repository's primary
product. It must not be published, tagged, or merged to `main` merely because compilation and
unit tests pass. Release approval requires the real installed Windows executable to complete the
feature matrix below on a clean Windows profile.

The Windows release version is `1.0.0`. Legacy releases used versions through `2.6.1`; therefore SemVer considers them
newer than `1.0.0`. Moving from the legacy application to OSG Windows 1.0 is a one-time manual
migration. Automatic signed updates begin with the OSG Windows 1.x release line.

## Release topology

- Official product name: **OSG Windows**.
- Supported release target: Windows x64.
- Official GitHub tag: `v1.0.0` only after this document is signed off.
- Native stable update metadata:
  `https://raw.githubusercontent.com/nganlinh4/oneclick-subtitles-generator/app-update-feed/osg-desktop-updater-v2.json`.
  The isolated feed branch contains metadata only, not application source or binaries. It is
  independent of GitHub Latest and the legacy Electron `latest.json`; no channel release is needed.
  Keep native application releases non-Latest while the legacy edition owns Latest. Do not merge
  or change the default `main` branch. Tauri still verifies the installer signature embedded in
  the manifest against the application's existing public key.
- Runtime/model assets: immutable, content-addressed managed deliveries, installed on demand.
  Reviewed UI-font resources ship with the app for offline first launch; other optional assets
  remain downloadable. The pool `osg-runtime-bundles-v1` is not an application release.
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
- [x] Four-target compile matrix remains green, without claiming runtime support for untested
  targets.
- [x] Installed Windows EXE reaches `app.start`, managed UI-font readiness, and `app.ready` in order
  on a clean CI profile and remains responsive.
- [x] Manual `installed-smoke` builds the current branch, validates its unsigned NSIS package, and
  installs/launches it on an isolated runner; `published-installed-smoke` separately downloads and
  verifies the signed immutable GitHub release artifact. A published tag is never used as evidence
  that the branch currently under review can be installed.

## Evidence ledger

Passing an individual row records evidence for that row only; it does not complete a combined
feature-matrix checkbox or approve the release.

| Date | Scope | Result | Evidence and follow-up |
| --- | --- | --- | --- |
| 2026-08-12 | Four-target compile matrix | Pass | The full [rewrite CI run](https://github.com/nganlinh4/oneclick-subtitles-generator/actions/runs/31580705778) passed repository invariants and native builds for Windows x64, Linux x64, macOS arm64, and macOS x64 at commit `33753bea`. This is compile evidence only; Linux and macOS remain unsupported until maintained real-device validation exists. |
| 2026-08-12 | Installed Windows lifecycle | Pass | The isolated [installed-smoke run](https://github.com/nganlinh4/oneclick-subtitles-generator/actions/runs/31580705222) built commit `33753bea`, validated and silently installed the unsigned NSIS package, rendered a responsive 1024×1848 WebView with the managed Google Sans face and real Windows x64 `app_health` IPC, accepted graceful window close, relaunched with byte-stable font cache, uninstalled while preserving the user profile, reinstalled an identical executable (`a745c274…dc12`), and launched a third time. Three bounded PNG captures were produced with SHA-256 `2b90e206…1e95`, `7fb22997…61a1`, and `ca495aa9…94bf`. This successful rerun verifies fixes for both the original close hang and the cached-launch document-readiness race. |
| 2026-08-12 | Installed persistence and diagnostics | Pass | The corrected isolated [installed-smoke run](https://github.com/nganlinh4/oneclick-subtitles-generator/actions/runs/31585213436) built commit `76528982`, installed the current NSIS package, and preserved the exact setting string plus project UUID `019ff572-2132-7ba1-9e9c-5a29894963bf`, revision cursor, undo reason, and redo result through graceful relaunch, uninstall-with-profile-preservation, reinstall, and a third launch. All three WebViews remained responsive, log rollover preserved the byte-exact previous file while bounding the fresh log, and the captures had SHA-256 `8052c399…fa6d`, `51d88ecd…1ab`, and `0d3c6a4b…ab95`. The earlier failed probe had supplied an object to the compatibility string-setting contract; it was a harness defect, not application data loss. |
| 2026-08-12 | Managed Remotion delivery | Pass | The published Windows package installed, resolved, launched, and removed over HTTPS. |
| 2026-08-12 | Real Remotion render | Pass | The managed Node/Chromium worker rendered 24 frames of a one-second 640×360 composition and produced a validated MP4. The test found and fixed Node's rejection of canonical `\\?\` Windows worker paths. |
| 2026-08-12 | Parakeet local ASR | Pass | A clean managed install launched the real worker, transcribed bounded 16 kHz WAV audio, shut down, and removed immediately in 1,169.83 seconds. The first run exposed 993 generated `.pyc` files; managed Python now uses `-B` and a narrow migration removes only legacy `runtime/**/__pycache__/*.pyc`. |
| 2026-08-12 | Faster-Whisper Turbo local ASR | Pass | The 6.75 GiB managed package loaded CTranslate2 on CUDA, returned nonempty text and segments with bounded timestamps from real 16 kHz speech, shut down, and removed immediately. The first constructor probe found CTranslate2 rejected canonical Windows `\\?\` model paths; ASR now normalizes only host-owned process/protocol paths. The retained-install post-fix lifecycle passed in 233.50 seconds. |
| 2026-08-12 | Faster-Whisper Large-v3 local ASR | Pass | A clean 8.12 GiB managed install loaded the distinct Large-v3 CTranslate2 model on CUDA, returned nonempty text and bounded segments from real speech, shut down, removed immediately, and left no package/archive residue in 1,025.71 seconds. |
| 2026-08-12 | Qwen3-ASR 0.6B local ASR | Pass | The 8.70 GiB managed package loaded the pinned 0.6B model and separately pinned forced aligner on CUDA, returned nonempty text and bounded segments, shut down, and removed immediately. The first run exposed PyTorch's dependency on a username-derived Inductor cache under a scrubbed environment; ASR workers now receive process-private Torch/Numba caches and a fixed non-identifying worker identity. The retained-install post-fix lifecycle passed in 405.41 seconds. |
| 2026-08-12 | Qwen3-ASR 1.7B local ASR | Pass | A clean 9.14 GiB download published an 11.33 GiB receipt-verified package, loaded the pinned 1.7B model and forced aligner on CUDA, returned nonempty text and bounded segments from real speech, shut down, removed immediately, and left zero download/staging/trash residue in 1,892.07 seconds. |
| 2026-08-12 | Slim network speech runtimes | Pass | Reproducible, provider-specific Windows runtimes now retain exact CPython/wheel identities and license files while excluding build-only pip/setuptools and all GPU dependencies. Edge downloads 11.5 MB/installs 35.5 MB, gTTS 11.3 MB/34.3 MB, and Gemini 20.2 MB/61.9 MB; two clean builds were byte-identical and the published assets were read back by length and SHA-256. |
| 2026-08-12 | Managed Google Sans Flex lifecycle | Pass | The official-first font package installed from reviewed immutable sources, resolved its Latin/Vietnamese faces, reused a verified cache without another network operation, detected same-size corruption after manager restart, repaired the damaged face, and removed immediately. |
| 2026-08-12 | Managed Gemini voice samples | Pass | The 13.52 MB content-addressed pack downloaded from the application-owned bundle pool, verified all 30 WAV files (16.38 MB unpacked), resolved the opaque Achernar sample, and removed immediately without restart in 2.79 seconds. |
| 2026-08-12 | yt-dlp delivery and update source | Pass | The live GitHub resolver accepted the current official immutable release and rebuilt a strict platform delivery with exact binary, source revision, license, and third-party-notice identities. A separate real lifecycle installed the 18 MB executable, ran `--version` and matched its reviewed delivery version, reused the verified install without another download, and removed it immediately in 8.33 seconds. Mutable, prerelease, duplicate, malformed-version, and wrong-asset cases remain rejected. |
| 2026-08-12 | Deno native tool | Pass | The official immutable 42.69 MB Deno 2.9.5 archive installed on demand, the managed executable ran `--version` and matched the reviewed delivery, a second install reused the verified 97.41 MB runtime with zero download progress, and removal completed immediately in 22.59 seconds. |
| 2026-08-12 | FFmpeg and FFprobe native tools | Pass | The application-owned, content-addressed 109.73 MB FFmpeg 8.1.2 archive installed on demand; both managed Windows executables ran their real version probes, the verified 203.67 MB payload was reused without another download, and both tools were removed atomically in 67.43 seconds. |
| 2026-08-12 | Edge TTS | Pass | The new slim package completed a clean managed install, real provider synthesis, artifact validation, shutdown, immediate removal, and zero download/staging/trash residue in 16.14 seconds. |
| 2026-08-12 | gTTS | Pass | The 11.3 MB slim package completed a clean managed install, real provider synthesis, MP3 artifact validation, shutdown, immediate removal, and zero installed-package residue in 11.81 seconds. |
| 2026-08-12 | Gemini Live narration | Pass | The 20.2 MB slim package imported the configured key without printing it, completed a real `gemini-3.1-flash-live-preview` audio turn, validated the WAV artifact, shut down, and removed immediately in 31.75 seconds. |
| 2026-08-12 | F5-TTS | Pass | The receipt-verified 6.47 GiB managed package loaded on CUDA, synthesized a cloned-voice WAV from a bounded local reference, validated the artifact, shut down, and removed immediately in 292.74 seconds. Two real compatibility defects were fixed: Windows extended-length paths are normalized only at the supervised process boundary, and pinned TorchAudio 2.11 file I/O is replaced by bounded SoundFile decoding while tensor resampling remains managed. |
| 2026-08-12 | Chatterbox | Pass | The 11.15 GiB receipt-verified managed package loaded on CUDA, synthesized cloned-voice WAV audio, validated the artifact, shut down, and removed immediately. The first successful synthesis generated 52 Librosa/Numba cache files inside the runtime and removal correctly failed closed; workers now use a process-private temporary Numba cache, and a narrow migration removes only recognized `runtime/**/__pycache__/*.{pyc,nbc,nbi}` when no other undeclared file exists. The post-fix retained-install lifecycle passed in 403.58 seconds. |
| 2026-08-12 | Gemini media input | Pass with model constraint | The bounded live audio probe succeeds with `gemini-3.1-flash-lite`; the same request returned provider HTTP 500 twice with `gemini-3.5-flash-lite`, so 3.1 remains the candidate default pending recheck. |

## Real installed-EXE feature matrix

### First launch, migration, persistence

- [x] Clean install, launch, close, relaunch, uninstall, and reinstall.
- [ ] Bundled Google Sans Flex offline first launch, cache reuse and corruption repair.
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

### Rendering, images, and music

- [ ] The native export renders the frozen composition with local fonts, source media, subtitles,
  narration, progress, cancellation, recovery, preview, and explicit export.
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
3. Validate the installer and `.sig`, generate `osg-desktop-updater-v2.json`, and inspect the draft
   artifacts using authenticated retrieval. Prove signed updating with the isolated HTTPS fixture.
4. Keep the candidate as a draft on the native branch for owner review. Preserve legacy main/Latest.
5. With owner authorization, publish **OSG 1.0.0** using `gh release edit v1.0.0 --draft=false
   --latest=false`. Do not change legacy main/Latest. Download the public installer and verify its
   signature, receipt, byte length and SHA-256 against the validated candidate.
6. Upload support files without overwrite to `osg-runtime-bundles-v1` using the installer-hash
   naming contract above; read them back and verify bytes. Keep only the installer on the app
   release. Generate the manifest with `scripts/build-updater-manifest.js` from that signed
   installer, pointing to its public versioned download URL. Commit the resulting
   `osg-desktop-updater-v2.json` on `app-update-feed` and push without force. Initial publication
   uses a parentless metadata-only commit; subsequent commits retain that branch's parent/history.
   Reject downgrades or same-version changes during normal promotion. Never point the feed at a
   draft or rewrite its installer signature. Git history retains previous feed metadata.
7. Read the channel back over public HTTPS and verify its exact bytes and signed installer target.
   Run the published-installed smoke and verify a successful startup update check. Confirm GitHub
   Latest still resolves to `v2.6.1` and `main` is unchanged. Future versions repeat the same sequence:
   validated versioned release first, channel metadata last; no native installer rebuild is needed
   merely to move the channel to a newer signed version.
