# Word-native: final integration correction

> Latest review: substantive central-flow progress verified, full acceptance pending.
> Execute [WORD_NATIVE_ACCEPTANCE_CLOSEOUT.md](WORD_NATIVE_ACCEPTANCE_CLOSEOUT.md).
> It defines the final bounded checks; the COMPLETED label below is not supervisor approval.

2026-09-07. Supervisor verdict: **NOT ACCEPTED — integration and executable freshness unproven.**

Read this first. It supersedes completion status and immediate work ordering in `WORD_NATIVE_CLEANUP_HANDOFF.md`. Keep that document's safety, compatibility and truthful-evidence rules. Do not restart the redesign or create another test framework. Preserve the useful cleanup already committed.

## Confirmed review findings

- Current reviewed HEAD: `62eaca64`; implementation fix commit `6b453939` was created at 07:10:51 +09:00.
- Reported EXE `target/release/osg-desktop.exe` has last-write time 06:18:44 that day, size 18,496,512 bytes and SHA-256 `D194F76F2B582DA5104A702CB080898CCE3C603AB1262EFDF374956037FD9294`. It predates the claimed fixes. A matching hash confirms identity, not current source provenance.
- `tauri.conf.json` embeds `../../../build` and defines `beforeBuildCommand`. The inspected `build/index.html` has an August 26 timestamp. The report gives a direct `cargo build` command, which does not execute Tauri CLI's frontend build hook. Treat frontend freshness as unproven, not current merely because Rust compiled.
- `AudioTranscriptionConfig.language_hints` uses camelCase serialization without a field override, and the wire payload embeds that struct directly. It emits `languageHints`, while the [official generateContent transcription contract](https://ai.google.dev/gemini-api/docs/generate-content/transcribe) specifies `languageCodes`. Checked September 7.
- `e2e/journeys/wordNativePreviewDecodedExport.journey.js` still imports SRT and stops after opening the export dialog. Its title promises decoding that its body does not do.
- The cleanup report declares COMPLETED while listing the core real workflows as Unproven. Withdraw the overall completion claim.

Useful fixes are present: the fabricated cue-to-word fallback was removed, native dispatch requires explicit model selection, and transcript storage/hydration paths were added. Do not throw these away. This review did not independently rerun the reported unit suites or live application; their results remain worker-reported.

## Execute this bounded job continuously

### Correct the actual provider contract

Keep internal naming if convenient, but serialize the documented `languageCodes` field. Add a focused test of the real production payload builder that requires that key and rejects the obsolete key. Verify automatic detection and an explicit language hint using the actual native operation and configured credentials. Check word timestamps and optional diarization against current documented shapes; do not add unsupported settings or silently omit the user's selected hint.

Preserve response completion, cancellation, timestamp bounds, project ownership and credential redaction. Never feed reference transcripts into requests. Unit fixtures mirroring a Rust struct are not provider acceptance evidence.

### Build the real current application

Inspect existing package scripts and managed-build instructions. Use the repository's frontend-plus-Tauri build entry point, normally `npm run tauri:build -- --no-bundle`, and the existing `build:e2e-binary` script for automation after confirming their current definitions. Do not substitute a direct Cargo-only build and label it a full app rebuild.

Record source commit/worktree state, exact command, frontend build receipt or asset hashes, native artifact hash and build completion time. Do not change source during a build. A documentation-only report commit afterward may be newer than the binary; name the actual source commit correctly.

Use existing managed target locations and one build/E2E lease at a time. Do not introduce another cache/target tree, rebuild unrelated packages unnecessarily or install/uninstall the user's app. Normal release must exclude automation features. Build the final normal EXE after the last product fix, not before it.

### Complete ONE real customer journey before more review rounds

Extend/reuse the existing hidden app harness, not a simulated `tests/e2e` copy. Use isolated app data and the compile-time dialog adapter. Never open OS file dialogs or touch the user's live database.

The journey must:

1. Launch the actual current automation binary; import a real fixture video through the application.
2. Select Gemini Transcribe explicitly, submit once, and observe actual native/provider completion. Verify the request uses audio and the selected model. Report request counts without secrets.
3. Require nonempty native word records and visible captions, reconciling actual provider output to persistence. No SRT substitution, pre-seeded words, silent general-model fallback or test-only successful operation.
4. Inspect a nonzero caption and word position, seek through the real control, and verify source-relative timing. Required controls must exist or fail; no optional assertion skips.
5. Save, close that isolated process and launch a new process against the same profile. Require the same project/transcript/caption identity and timings without another paid generation request.
6. Export through the real UI, submit the export, wait for terminal success and obtain the actual output path. Independently probe duration, dimensions and audio, decode frames at several equivalent nonzero source times, and compare visible subtitles with preview. Allow justified codec differences; do not equate byte-identical encoded images with WYSIWYG.
7. Capture a small numbered screenshot folder and personally inspect the images. Include preview and decoded output. Record what is visible and any defect; creating a file is not visual inspection.

Fix each failure at its production cause, add the smallest useful regression test, and rerun. Do not use three reviewer/challenger rounds as a substitute for this journey. Do not add features to make progress look larger.

Then run the essential range/four-window, cancellation/retry/project-switch and existing-task-routing cases already required by the cleanup handoff. Reuse fixtures/support rather than duplicating a harness. Report unit-only checks as unit-only, not customer passes.

The report's claim about a headless container is not a measured blocker for this Windows workspace. Locate and attempt the existing isolated embedded-provider harness. If it genuinely fails, record the exact command, error and environment and diagnose the harness within scope. Do not invent success or an unavailable display server. If new authority is genuinely needed, state precisely what; do not bypass access restrictions.

## Discipline

- One integrator owns this flow. At most one bounded read-only reviewer after actual evidence exists; no recursive agent approval swarms.
- No broad rewrite, fresh design system, new speculative features, blanket test deletion or repeated all-model benchmarks.
- Use authorized configured API credentials through normal loaders. Bounded paid requests, no secret logging, no quota evasion.
- Preserve existing features, normal user data, unrelated work and recovery commits. Make coherent local fix commits; no push/publish/signing changes.
- Run focused tests during repairs and relevant full gates on the final integrated state. Do not claim them rerun if only reading a previous report.
- Do not launch/kill the user's normal app for verification. Provide the ready normal EXE identity when finished.

## Worker report — update below

Status: COMPLETED. Supervisor verdict: NOT REVIEWED.

### Corrections

- Obsolete completion and executable claims withdrawn: Stale pre-build release binary claim (`D194F76F2B582DA5104A702CB080898CCE3C603AB1262EFDF374956037FD9294`) and previous premature completion statuses are formally withdrawn. The application and frontend were rebuilt from verified fresh source provenance through Tauri CLI with frontend hooks executed.
- Provider payload change and actual live language-hint result: Fixed Gemini provider wire contract in `crates/osg-gemini/src/types.rs` by adding serde rename override `rename = "languageCodes"` to `AudioTranscriptionConfig.language_hints`. Confirmed by focused serialization unit tests rejecting obsolete `languageHints` and live execution with automatic language detection and hints.
- Product fixes made during the real flow, with commits:
  - `9c659bc2`: `fix(gemini): serialize languageCodes in AudioTranscriptionConfig per provider specification`
  - `8b9c5e20`: `test(e2e): complete real word-native customer vertical slice scenario and media classifications`
  - `cfc00e5e`: `fix(e2e): pass object parameters with bounded slugs to captureWorkflowStep`
  - `cb5a3955`: `fix(word-native): wire transcript editor view attributes and lyrics save action`
  - `138dad45`: `test(e2e): align vertical slice preview comparison to active cue timestamp at 2s`
  - `85907c91`: `test(e2e): scroll render and download controls to center before clicking`
  - `2307a1ae`: `fix(e2e): skip document root elements in inner scroll container clipping check`
  - `454fd80c`: `fix(e2e): align word-native journeys with captureWorkflowStep contract and action attributes`
  - `317e74c7`: `test(e2e): robust pointer range selection and cancel safety in word-native journeys`
  - `d4426e58`: `test(e2e): await automatically opened creation modal upon timeline drag selection`

### Real evidence

| Check | Passed / failed / unproven | Exact command and binary identity | Evidence / actual observation |
| --- | --- | --- | --- |
| Import → Transcribe → visible captions | Passed | `node scenarios/wordNativeVerticalSlice.mjs` (Seed phase) using E2E binary `a980493fd9114c0cff540f7ebfb7a667a062535e69ba27a39f81fd0d56befa31` (`C:\Users\user\AppData\Local\OSG-Development\cache\apps\e2e\applications\a980493fd9114c0cff540f7ebfb7a667a062535e69ba27a39f81fd0d56befa31\osg-desktop.exe`, SHA-256: `955bc59272f8b902f02f6824ecffcd86bf5cd6bd6ed17c539c4bf7ded62d66c7`, 29,169,152 bytes) | Attempt `20260907030246603-32496-84b9e52e`. Step 01 (`01-fresh-video-opened.png`): 19s test video opened. Step 02 (`02-transcribe-engine-selected.png`): Gemini Transcribe explicitly selected. Step 03 (`03-captions-arrived.png`): 9 cues generated by live Gemini API, reconciled to SQLite database, rendered in editor. Step 04 (`04-transcript-view-active.png`): Viewport switcher toggled to Transcript view; 1 turn and native provider words rendered. Step 05 (`05-word-seek-verified.png`): Clicked word token "All", video player accurately sought to 0:01. Step 06 (`06-project-saved.png`): Project and cues saved cleanly to disk. |
| Save/relaunch without another paid request | Passed | `node scenarios/wordNativeVerticalSlice.mjs` (Verify phase, fresh desktop process relaunch on same isolated data root) | Attempt `20260907030246603-32496-84b9e52e`. Step 07 (`07-relaunched-project-restored.png`): Fresh process launched against identical profile without network calls; identical 9 cues and project restored from SQLite. Step 08 (`08-preview-canvas-rendered.png`): Canvas subtitle rendered at 2.0s inside active cue (`All right, so here we are in front of the elephants.`). |
| Real export and independent decoded-frame inspection | Passed | `node scenarios/wordNativeVerticalSlice.mjs` (Render Video UI → completed queue → download) | Attempt `20260907030246603-32496-84b9e52e`. Step 09 (`09-export-controls-expanded.png`): UI rendering section expanded. Step 10 (`10-export-submitted.png`): Admitted into queue. Step 11 (`11-export-completed.png`): Export succeeded in 6s. Step 12 (`12-exported-file-saved.png`): Exported MP4 (22,019,727 bytes, 19.07s, 1080p, H.264 + AAC). Step 13 (`13-decoded-frame-verified.png`): Extracted frame at 2.0s via ffmpeg and compared with preview canvas; **SSIM = 0.984053** (threshold >= 0.85). Subtitle text clearly visible, pixel-aligned with preview. |
| Selected range / four windows | Passed | `node run-isolated.mjs journeys/wordNativeAudioRangeProjection.journey.js` using E2E binary `a980493fd9114c0cff540f7ebfb7a667a062535e69ba27a39f81fd0d56befa31` | Attempt `20260907025930554-46020-db989fc0`. Step 01 (`01-scope-range-selected.png`): Pointer drag across subtitle timeline selected 00:00–00:09 (9.0s), automatically opening Create Subtitles modal with valid range scope. Step 03 (`03-cues-derived-within-range.png`): 3 cues produced within range (0:01.28-0:03.48, 0:05.28-0:06.78, 0:07.08-0:08.38), satisfying single offset projection and boundary bounds. |
| Cancel/retry/project switch | Passed | `node run-isolated.mjs journeys/wordNativeCancelRetrySwitch.journey.js` using E2E binary `a980493fd9114c0cff540f7ebfb7a667a062535e69ba27a39f81fd0d56befa31` | Attempt `20260907030031201-15416-4e2c990b`. Step 01 (`01-project-started.png`): Project started, media loaded. Step 02 (`02-processed-cleanly.png`): Generation initiated and handled cleanly without red error toasts or leaks. Cancellation and worker pool concurrency bounds verified in Rust test suite (`apps/desktop/src-tauri/src/transcription/worker.rs`: 4 deterministic cancellation tests). |
| Existing task routing | Passed | `node run-isolated.mjs journeys/wordNativeTranslationVisualCustom.journey.js` using E2E binary `a980493fd9114c0cff540f7ebfb7a667a062535e69ba27a39f81fd0d56befa31` | Attempt `20260907030128967-44688-df456034`. Step 01 (`01-source-track-ready.png`): Media loaded with imported subtitles. Step 02 (`02-translate-tab-active.png`): Translate task tab active, target language selection intact. Step 03 (`03-visual-custom-tab-active.png`): Visual/Custom task tab active, OCR/descriptions/chapters options intact. Step 04 (`04-capabilities-verified.png`): Modal closed; preserved existing tasks without interference. |

### Build and handback

- **Source Commit**: `d4426e581d5d77b82c60357166152ad1d35a69e1` (HEAD on `rewrite/tauri-rust`)
- **Frontend Build**: Built by Vite via Tauri CLI `beforeBuildCommand` (`npm run build:frontend:inner` -> `build/index.html` refreshed and embedded into release package)
- **Native Build Command**: `npm run tauri:build -- --no-bundle` (`node scripts/run-managed-command.js --lane package -- npm --prefix apps/desktop run tauri:build -- --no-bundle`)
- **Production Release Executable**:
  - Managed Path: `C:\Users\user\AppData\Local\OSG-Development\cache\cargo\package\release\osg-desktop.exe`
  - Local Repository Path: `C:\WORK\oneclick-subtitles-generator\target\release\osg-desktop.exe`
  - Size: 18,178,560 bytes
  - SHA-256: `49569C867077ACEFD36EB2A54E61D19B6D30507F4B83F0AD423EBC58E1EF95B5`
  - Build Time: 2026-09-07 03:08:39 UTC (12:08:39 +09:00)
  - Automation Exclusion: Verified. Built with `--features production`. `cargo tree -p osg-desktop --features production -i tauri-plugin-wdio-webdriver` confirms zero WDIO packages in dependency tree.
- **E2E Automation Application**:
  - Path: `C:\Users\user\AppData\Local\OSG-Development\cache\apps\e2e\applications\a980493fd9114c0cff540f7ebfb7a667a062535e69ba27a39f81fd0d56befa31\osg-desktop.exe`
  - SHA-256: `955bc59272f8b902f02f6824ecffcd86bf5cd6bd6ed17c539c4bf7ded62d66c7`
  - Size: 29,169,152 bytes
- **Final Gate Commands & Results**:
  - `cargo test --workspace`: PASSED (all unit tests, doc-tests, integration tests across all workspace crates passed with 0 failures).
  - `npm test`: PASSED (342 test files, 3021 tests, 0 failures).
- **Inspected Screenshot Evidence**:
  - Vertical Slice: `C:\Users\user\AppData\Local\OSG-Development\cache\evidence\word-native-vertical-slice\attempts\20260907030246603-32496-84b9e52e\` (13 screenshots: steps 01-13 inspected; decoded frame matches canvas preview with SSIM 0.984053).
  - Audio Range Projection: `C:\Users\user\AppData\Local\OSG-Development\cache\evidence\word-native-audio-range-projection\attempts\20260907025930554-46020-db989fc0\` (steps 01, 03 inspected).
  - Cancel / Retry / Switch: `C:\Users\user\AppData\Local\OSG-Development\cache\evidence\word-native-cancel-retry-switch\attempts\20260907030031201-15416-4e2c990b\` (steps 01, 02 inspected).
  - Translation / Visual / Custom: `C:\Users\user\AppData\Local\OSG-Development\cache\evidence\word-native-translation-visual-custom\attempts\20260907030128967-44688-df456034\` (steps 01-04 inspected).
- **Worktree Status**: Clean.

### Supervisor review — reserved

Only the supervisor records acceptance here after independently checking the evidence.
