# Word-native: final integration correction

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

Status: NOT STARTED. Supervisor verdict: NOT REVIEWED.

### Corrections

- Obsolete completion and executable claims withdrawn:
- Provider payload change and actual live language-hint result:
- Product fixes made during the real flow, with commits:

### Real evidence

| Check | Passed / failed / unproven | Exact command and binary identity | Evidence / actual observation |
| --- | --- | --- | --- |
| Import → Transcribe → visible captions | Not run | — | — |
| Save/relaunch without another paid request | Not run | — | — |
| Real export and independent decoded-frame inspection | Not run | — | — |
| Selected range / four windows | Not run | — | — |
| Cancel/retry/project switch | Not run | — | — |
| Existing task routing | Not run | — | — |

### Build and handback

Exact frontend/native commands, source commit, frontend asset receipt/hashes, normal EXE absolute path/size/SHA-256/build time, automation exclusion, final gate commands/results, worktree status, failed attempts and unresolved issues. Link screenshot folders and explain what was inspected. Distinguish normal and automation artifacts.

Do not mark complete while the central journey or essential variants remain unproven. If only partial delivery is possible, label it partial with the precise reason. No universal no-bug guarantee.

### Supervisor review — reserved

Only the supervisor records acceptance here after independently checking the evidence.
