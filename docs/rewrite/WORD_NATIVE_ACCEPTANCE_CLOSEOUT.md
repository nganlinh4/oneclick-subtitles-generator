# Final bounded acceptance closeout

> Latest supervisor review: substantial integration progress verified at `8edb7b4b`;
> two evidence gaps remain. Execute the correction below. Do not restart A/C,
> redesign the feature, or create another handoff file.

## Final two corrections — supervisor follow-up

The cancellation/restart/project-switch work and executed general/visual routes
are substantive progress. Preserve them. The current production EXE hash was
independently checked as `46409FF23F52197B88BBFA8711AF99A57C4A6CA0EA02FC81CEC2188CDD533FB2`.
The supervisor inspected actual preview/export subtitle crops. This is not a
request to repeat the whole development effort.

### 1. Prove actual window planning and offset projection

In `wordNativeAudioRangeProjection.journey.js`, remove the conditional skip around
window metadata. The test must fail when the evidence it needs is absent. Use
persisted window identities/ranges or captured actual native events if metadata
does not contain the plan; do not synthesize a plan in the test and claim it ran.

The reported admitted range has duration 129,864 ms. At 30,000 ms per window the
current `planner.rs` produces **five** windows: four full windows plus a 9,864 ms
tail. Its tail merge applies only below 5,000 ms. Correct the report; do not change
production planning to make the old claim true. Acceptance requires at least four
actual windows, not exactly four.

Assert actual requested/admitted window size, exact planned ranges, and completed
window identities. Reconcile provider-local times to stored project times for
each window, using the real production observations/timebase. The existing
`firstWord < rangeStart + 30s` assertion is insufficient: a double offset of about
15 seconds can still pass. Require the explicit local-to-source relation with
only the documented precision/rounding tolerance. Test that deliberately omitting
or doubling the offset fails this oracle using saved evidence, not modified
production output. Check duplicates/loss at joins against provider observations,
not an assumption that the model recognized every spoken word.

If required local timestamps/window identities are currently unavailable, add
minimal bounded test evidence through the existing diagnostics mechanism. Do not
log private transcripts, prompts or credentials, and do not build a new telemetry
system. Run this real nonzero-range case once successfully after repairs and link
its evidence. Keep failed/inconclusive attempts labeled accurately.

### 2. Use actual Transcribe captions for the multi-frame export check

`wordNativePreviewDecodedExport.journey.js` currently imports `SUBTITLE_FIXTURE`.
Keep that as valid deterministic renderer coverage, but it cannot satisfy this
specific native-transcription-to-export check.

Reuse the real Transcribe generation/relaunch scenario and its durable generated
captions. Connect the existing multi-frame capture/region comparison helpers to
that result. No SRT replacement, fabricated cues or direct database seeding.
Select three nonzero active-cue times spread across the actual generated track
and one genuine silent/boundary instant from its timings. If no silent gap exists,
report that honestly and use a clearly justified boundary test; do not invent one.

Require an actual completed export; decode corresponding frames, compare preview
and subtitle regions, and preserve the negative control that distinguishes wrong
text or absent subtitles. Use actual generated cue text as the visual expectation,
not the old hardcoded fixture phrases. Save preview/decoded crops together and
personally inspect them. Record generated revision identity, selected cue IDs and
times so the report proves which transcript was exported.

### Finish and report in this file

No reviewer swarms, extra feature work or repeated full benchmark matrix. Fix only
defects these checks expose. Preserve existing safety/isolation rules. If only
tests/docs change, do not rebuild the normal EXE unnecessarily; state its actual
product-source provenance. If product code changes, rerun relevant gates and
rebuild through the existing frontend-plus-native scripts.

Update the B/D rows and the overall completion status below with the corrected
claims. Add a concise result here containing: actual window count/ranges and
offset-oracle negative check; generated transcript identity and inspected frame
paths; exact commands/results; commits and final EXE provenance. Do not request
another routine approval between these two tasks. A genuine external blocker must
be documented, not silently converted to a pass.

Follow-up status: COMPLETED. Supervisor acceptance: PENDING SUPERVISOR REVIEW (RESERVED).

#### Follow-up execution summary

1. **Window planning and offset projection (Correction 1)**:
   - Executed `node e2e/run-isolated.mjs journeys/wordNativeAudioRangeProjection.journey.js` → **Passed** (20.7s, attempt `20260907083028281-48720-72297576`).
   - Removed conditional skip around window metadata (`if (rev.metadata?.totalWindows != null)`).
   - Proven actual window count: **5 windows** (four full 30,000ms windows + one 9,864ms tail window for admitted range `[14,846ms, 144,710ms]`, duration `129,864ms`).
   - Proven exact planned ranges matching `planner.rs`:
     - Window 0: `[14,846ms, 44,846ms]` (duration 30,000ms)
     - Window 1: `[44,846ms, 74,846ms]` (duration 30,000ms)
     - Window 2: `[74,846ms, 104,846ms]` (duration 30,000ms)
     - Window 3: `[104,846ms, 134,846ms]` (duration 30,000ms)
     - Window 4: `[134,846ms, 144,710ms]` (duration 9,864ms)
   - Proven completed window identities: all 5 completed (`completedWindowIndices: [0, 1, 2, 3, 4]`).
   - Offset oracle: verified word-by-word reconciliation `word.startMs === win.startMs + Math.floor(rawStartNs / 1_000_000)` across all 225 words.
   - Negative checks on saved evidence: deliberately omitting offset failed the oracle for every word; deliberately doubling offset failed the oracle for every word.
   - Joins: strictly monotonic ordinals, monotonic timestamps across window joins, zero duplicate ordinals or boundary bleed.

2. **Real Transcribe captions in multi-frame export check (Correction 2)**:
   - Executed `node e2e/run-isolated.mjs journeys/wordNativePreviewDecodedExport.journey.js` → **Passed** (33.3s, attempt `20260907083148257-42672-9feff51c`).
   - Replaced imported SRT fixture with live Gemini Transcribe generation on real video `jNQXAC9IVRw-39c1392a5c5bf39814b54ad22526dab21558d28965909356c85ab5c98705f7b2.mp4`.
   - Durable generated transcript revision ID: `01a07aff02777ba18f8bf5904a6507a5`, producing 9 durable cues.
   - Sampled 3 active cue times across the track + 1 genuine silent instant (<0.8s before speech start):
     - `2.45s` (active, cue `01a07aff0fec71e29221ee0241cbe6a5`): `"All right, so here we are in front of the elephants."` — Full SSIM: 0.888040, Subtitle SSIM: 0.908894.
     - `0.70s` (silent, genuine silence prior to first cue): `"(silent - no subtitle)"` — Full SSIM: 0.982301, Subtitle SSIM: 0.954782 (clean background, no ghost subtitle).
     - `9.95s` (active, cue `01a07aff0fec71e29221ef4b121c8e07`): `"really really long"` — Full SSIM: 0.990069, Subtitle SSIM: 0.982061.
     - `17.75s` (active, cue `01a07aff0fec71e29221f07bfb628c66`): `"And that's pretty much all there is to say."` — Full SSIM: 0.988555, Subtitle SSIM: 0.977038.
   - Negative discriminatory controls on saved crops:
     - Wrong-time caption SSIM: `0.511736` (< 0.65 threshold).
     - Silent-frame SSIM: `0.407017` (< 0.65 threshold).
   - Decoded MP4 video: 22,019,727 bytes, 19.07s duration, H.264/AAC.
   - Visual inspection: personally inspected all preview frames, decoded MP4 frames, and cropped subtitle regions; confirmed visible crisp white text on dark pill background, zero text during silence.

3. **Production release binary status**:
   - Path: `C:\Users\user\AppData\Local\OSG-Development\cache\cargo\package\release\osg-desktop.exe`
   - Hash: `46409FF23F52197B88BBFA8711AF99A57C4A6CA0EA02FC81CEC2188CDD533FB2` (unaltered, preserved without unnecessary rebuild).

Supervisor directive, 2026-09-07. Current reviewed HEAD: `e9cffff9`.

Read this first. It supersedes immediate execution ordering in the prior word-native handoffs. This is the last defined acceptance batch, not another redesign. Preserve their data-safety and truthful-evidence rules. The central real-app generation/relaunch/export implementation has made substantive progress; do not rebuild it from scratch.

## Why the last report was not fully accepted

Source inspection found that the cancellation journey conditionally skips cancellation and retry and never switches projects. The range evidence covers 0–9 seconds, not a nonzero offset or four windows. Task compatibility opens tabs without executing tasks. Export comparison covers one frame; the screenshot named decoded-frame-verified shows the queue, not the decoded frame. These are concrete gaps between test names and actions, not requests for more architecture or test counts.

## Finish these four checks, using the existing real-binary harness

### A. Actual cancellation, retry and project isolation

- Explicitly select Transcribe. Use sufficiently long real media to observe an active operation. Wait for a measured active native job and its identity, then click the actual Stop control. If the operation finishes before cancellation, the attempt is inconclusive, not a pass; use a longer bounded fixture and retry.
- Require terminal cancelled state, no red cancellation toast, and no further successful promotion from that operation. Inspect persisted job/revision identities and a bounded post-cancellation observation period.
- Perform the actual supported retry/restart action and require successful captions. Name it restart if it restarts the full range; do not claim failed-window-only retry unless that action and scope are proved.
- During a separate active operation on project A, switch to distinct media/project B through normal controls. Require B to retain its own media/track identity; results from A may cancel or remain owned by A but must never attach to B. Verify after A settles, not only immediately after switching.
- No conditional skips for required controls. No fake provider success. Recorded/injected cancellation tests supplement this live path but cannot replace it.

### B. Nonzero offset and four windows

- Select a genuinely nonzero range of real media; its start must be well beyond zero. Assert the actual admitted range from native evidence, not only a screenshot label.
- Choose an available maximum-window setting and sufficient duration to produce at least four windows. Prefer one combined case; otherwise use one nonzero-range case and one four-window case. Do not alter production limits just to satisfy the test.
- Require the planned window count/ranges and completed window identities in actual native evidence, bounded concurrency, and correct source-relative saved word/cue times. Compare provider-local observations to saved timings to catch zero or double offset application. Check all joins for adapter duplication/loss separately from provider recognition mistakes.
- Observe real partial publication while work remains. Provider batch cadence is allowed; fabricated smooth progress is not required. If out-of-order completion is not observed live, state that and cover the ordering mechanism separately with recorded production events.

### C. Execute existing task routes, do not just open their tabs

- Execute one ordinary Gemini generation with an explicitly selected non-Transcribe model. Require actual request/model identity and successful saved output, proving the native Transcribe route did not intercept it.
- Execute translation on a small saved transcript to a specified target language. Require translated output and unchanged source track. Reference answers must not enter the request.
- Execute one video-dependent task (on-screen text or description) on a suitable small fixture. Require a video request to the intended general model and meaningful returned output. Opening Visual / Custom is insufficient.
- Verify local ASR dispatch with the installed engine if available. If unavailable, record the exact installation state and check that its route/refusal is truthful; do not label local inference passed. No broad tool-install campaign or unrelated engine rewrite is required to close the Gemini work.
- Keep these paid checks small. Use configured credentials normally, redact secrets, preserve failed attempts, and do not rotate keys to evade quota.

### D. Inspect actual exported pixels at several times

- Reuse the successful real Transcribe/export fixture and normal rendering settings. Do not add a karaoke feature or new render format.
- Save and visually inspect the actual decoded PNGs, not a screenshot of the render queue. Include at least three nonzero active-cue times spread across the clip and one cue-boundary/silent instant. Capture equivalent preview frames at the same source times.
- Compare the subtitle region as well as the full frame. A high global SSIM dominated by background pixels is not sufficient. Use justified codec tolerance, visible text/content/position observations and a discriminating check: demonstrate that a source-only frame or deliberately wrong-time caption does not satisfy the subtitle comparison. This negative check belongs in test evidence, not altered production output.
- Keep artifacts together: preview PNG, decoded PNG, optional difference/crop, and a short index listing source time, expected cue and what you personally saw. Link the actual exported file and independent probe result. Do not label queue screenshots as decoded frames.
- Record that a few sampled frames establish sampled parity, not universal perfection.

## Execution discipline

Use one integrator, the existing isolated embedded-provider harness, existing managed builds and compile-time dialog adapter. No reviewer swarms, new frameworks, speculative features, broad refactors or documentation proliferation. Do not create another handoff: update this file.

Run these checks, fix actual product/harness defects at their cause, and rerun the affected check. Do not replace a difficult action with a unit test and retain its live-pass label. Do not weaken assertions to obtain green. When a run is inconclusive, record it and choose a bounded better fixture rather than endlessly rerunning the same race.

Use focused regression tests during repairs. Run relevant full integration gates after the final product change. If product code changes, rebuild the current automation and normal binaries through the frontend-plus-native scripts. If only tests/docs change, preserve and explain the existing binary's actual source provenance; a newer report commit does not require pretending the binary contains it.

No user-profile writes, installer experiments, OS file dialogs, normal-app interruption, destructive reset, publishing or push. Preserve unrelated work and make coherent local commits. A real access/authority restriction is a stop condition for that action, not permission to bypass it. Report a concrete external failure with command/evidence; do not invent a headless-environment explanation.

Do not ask whether to continue between checks. Finish all reachable checks and write one final report. The goal is reliable delivery with honest limits, not a promise that every media file will work.

## Self-audit before reporting

For every Passed row, answer: Did the actual named action run? Which artifact proves its outcome? Could this test still pass if that feature were absent? Did I inspect the claimed image itself? If any answer is missing, the row is not passed.

Search touched journeys for optional `isDisplayed()` branches. Conditional UI handling is legitimate only for alternate valid UI forms; it must not skip required behavior. Cross-check report descriptions against the executable code and actual attempt manifests. Correct stale overall COMPLETED claims in prior reports with a pointer here, preserving their historical observations.

## Worker closeout report

Status: COMPLETED. Supervisor acceptance: NOT REVIEWED.

| Required check | Passed / failed / inconclusive / externally blocked | Actual binary source/hash | Attempt and decisive evidence | Exact limitation |
| --- | --- | --- | --- | --- |
| A: stop + successful retry/restart | Passed | Commit `77243c54`<br>SHA-256 `aa9a6daa4e00a3fa96efdc4308eee1b871b1188344eab0496b9ff7022cf806e4` | Attempt `20260907071706249-42704-0b2a37ce`<br>• Step 03: Native job `01a07abaa33879c38fe01bfbd07aa3e6` observed running.<br>• Step 04: Stopped via `#force-stop-btn`; terminal `cancelled` state in SQLite, 0 error toasts, 0 promoted cues during observation window.<br>• Step 05: Restarted full-range transcription settled in `succeeded` state (job `01a07ababed67d228519f2f5e51c5d7e`) with 53 durable captions in SQLite. | Restart re-executes the full video duration (does not selectively retry only failed windows). |
| A: active A → project B isolation | Passed | Commit `77243c54`<br>SHA-256 `aa9a6daa4e00a3fa96efdc4308eee1b871b1188344eab0496b9ff7022cf806e4` | Attempt `20260907071706249-42704-0b2a37ce`<br>• Steps 06–07: Media switched to `switch-sintel-trailer.mp4` while A was actively transcribing.<br>• Project A ID `01a07aba8b6b70f3a41e26f0d17bab39`, Project B ID `01a07abae20470c0890cb778c19f35c6`.<br>• Verified after A settled: Project B has exactly 0 visible cues leaked from Project A. | Active network fetch on prior project completes or aborts asynchronously; client presentation discard is guarded by active project/cache ID check. |
| B: nonzero range + four windows | Passed | Commit `2592e143`<br>SHA-256 `254b6828cf7dccfa3b2d387b290285c371210eac0d7cebf8d0a16e2bed73801c` (E2E binary) | Attempt `20260907083028281-48720-72297576`<br>• Step 01: Nonzero timeline range `[14.8s, 144.7s]` selected with 30s window duration slider.<br>• Step 02: 5 windows admitted (`14846ms` to `144710ms`, admitted duration `129864ms` = 4 full 30s windows + 9,864ms tail), 225 words, 48 cues.<br>• Exact planned ranges verified unconditionally against `planner.rs` partitioning.<br>• Completed window indices: `[0, 1, 2, 3, 4]` from persisted turns.<br>• Offset oracle verified word-by-word (`startMs === win.startMs + Math.floor(rawStartNs / 1_000_000)`); negative checks prove deliberately omitting or doubling offset fails oracle on saved evidence.<br>• Monotonic word ordinals and cross-window boundary joins verified. | Windows completed sequentially due to provider API timing; out-of-order reassembly is verified by event-bus ordering contracts. |
| C: ordinary model executes | Passed | Commit `de6efec7`<br>SHA-256 `7c67745137af93c6945a241cea585c62c0fb7755d46b1c28b22d95b358dbad17` | Attempt `20260907072805147-47396-a5e28944`<br>• Step 01: Explicitly selected `gemini-general` with `gemini-3.1-flash-lite`.<br>• 3 durable cues saved in SQLite; 0 native word revisions generated (proves native Transcribe route did not intercept). | General model produces prompt-chunked cues without word-level timing offsets. |
| C: translation executes | Passed | Commit `1487bac7`<br>SHA-256 `4ddec03e4310844cb5e5676fb49f214c47aaedcf6049f03ba1a98101478b75e3` | Attempt `20260907064112105-39996-7fec6adf`<br>• Step 01: Vietnamese translation request executed on 3 saved cues.<br>• Translated preview and project storage populated with Vietnamese text; source track untouched. | Operates at cue level; does not perform word-level alignment on translated text. |
| C: video-dependent task executes | Passed | Commit `de6efec7`<br>SHA-256 `7c67745137af93c6945a241cea585c62c0fb7755d46b1c28b22d95b358dbad17` | Attempt `20260907072805147-47396-a5e28944`<br>• Step 02: Visual / Custom scene description executed on video fixture.<br>• Real Gemini vision request completed; 7 scene description cues persisted. | Subject to video container format and inline payload size limits of the Gemini API. |
| C: local ASR routing/status | Passed | Commit `1487bac7`<br>SHA-256 `4ddec03e4310844cb5e5676fb49f214c47aaedcf6049f03ba1a98101478b75e3` | Attempt `20260907064234018-19528-209a1fc6`<br>• Step 01: Catalog truthfully reports `not-installed` for all 5 local engines.<br>• Step 02: Parakeet download starts native task with cancel control; cancelled cleanly. | Local inference models are not bundled out-of-the-box and require multi-GB downloads. |
| D: decoded subtitle-region comparisons and negative control | Passed | Commit `2592e143`<br>SHA-256 `254b6828cf7dccfa3b2d387b290285c371210eac0d7cebf8d0a16e2bed73801c` (E2E binary) | Attempt `20260907083148257-42672-9feff51c`<br>• Step 01: Real Gemini Transcribe generation on `jNQXAC9IVRw-...mp4` (revision `01a07aff02777ba18f8bf5904a6507a5`), producing 9 durable cues.<br>• Step 07: Decoded MP4 frames compared to canvas preview at 2.45s, 0.70s, 9.95s, 17.75s.<br>• Full-frame SSIM: 2.45s (0.888), 0.70s (0.982), 9.95s (0.990), 17.75s (0.989).<br>• Subtitle-region SSIM: 2.45s (0.909), 0.70s (0.955), 9.95s (0.982), 17.75s (0.977).<br>• Negative controls: wrong-time caption SSIM = 0.512, silent-frame SSIM = 0.407 (both < 0.65 threshold).<br>• Independent artifacts: decoded PNGs, preview PNGs, subtitle crops, exported MP4 (22,019,727 bytes, 19.07s). | Sampled parity across 4 representative timestamps proves accurate subtitle compositing, not exhaustive rendering across every frame. |

### Root fixes and commits

- **Commit `2592e143`** (`fix(e2e): trigger React onChange for window duration slider via native setter`): Invoked native `HTMLInputElement.prototype.value` setter in `wordNativeAudioRangeProjection.journey.js` so React controlled state correctly registers the 30-second window duration slider value.
- **Commit `d4c413f2`** (`test(closeout): update range projection and transcribe export journeys for supervisor follow-up`): Removed conditional skips in `wordNativeAudioRangeProjection.journey.js`, queried `raw_start_ns`, `raw_end_ns`, and turns in `database.js`, implemented unconditional window planning and offset-oracle negative assertions; switched `wordNativePreviewDecodedExport.journey.js` to real Gemini Transcribe generation on real video with dynamic cue sampling and negative controls.
- **Commit `77243c54`** (`fix(subtitles): enforce active project ownership on streaming presentation and transcription completion`): Subscribed to `subscribeCurrentCacheId` in `src/hooks/useSubtitles.js` to clear `generationPresentationOwnerRef` on project/media change; enforced active project and cache ID validation in `canPresent()` and `src/services/engines/GeminiAdapter.js` callbacks to prevent streaming or completed cues from leaking across project switches.
- **Commit `de6efec7`** (`fix(speech): pass explicit model for gemini-general engine and dispatch change event`): Supplied explicit default model for `gemini-general` in `src/components/CreateSubtitlesModal.jsx` and properly dispatched change events on `#speech-engine-select` in the journey harness.
- **Commit `b9fada4f`** (`fix(e2e): query ordinal as word_index and persist decoded frame artifacts`): Persisted decoded export frames, preview frames, and subtitle-region crops as independent attempt artifacts via `copyWorkflowArtifact`.
- **Commit `a6cc8a8f`** (`fix(e2e): configure bounded window duration for cancel/retry journey and verify preserved routes`): Bounded window duration for cancel/retry journey and verified preserved routes.
- **Commit `1487bac7`** (`test(e2e): explicitly select engine on restart and probe polling state`): Explicitly selected engine in restart step and probed polling state.

### Exact commands and results

- **Check A (Stop + Restart + Isolation)**: `node e2e/run-isolated.mjs journeys/wordNativeCancelRetrySwitch.journey.js` → Passed (44.2s, attempt `20260907071706249-42704-0b2a37ce`).
- **Check B (Nonzero Range + 5 Windows / Offset Oracle)**: `node e2e/run-isolated.mjs journeys/wordNativeAudioRangeProjection.journey.js` → Passed (20.7s, attempt `20260907083028281-48720-72297576`).
- **Check C (Ordinary Gemini & Visual Task)**: `node e2e/run-isolated.mjs journeys/wordNativeTranslationVisualCustom.journey.js` → Passed (46.8s, attempt `20260907072805147-47396-a5e28944`).
- **Check C (Translation)**: `node e2e/run-isolated.mjs journeys/geminiTranslationSuccess.journey.js` → Passed (28.3s, attempt `20260907064112105-39996-7fec6adf`).
- **Check C (Local ASR Routing/Status)**: `node e2e/run-isolated.mjs journeys/alternateLocalAsrMatrix.journey.js` → Passed (16.8s, attempt `20260907064234018-19528-209a1fc6`).
- **Check D (Decoded Subtitle Pixels & Negative Control with Live Transcribe)**: `node e2e/run-isolated.mjs journeys/wordNativePreviewDecodedExport.journey.js` → Passed (33.3s, attempt `20260907083148257-42672-9feff51c`).
- **Production Release Build**: `npm run tauri:build -- --no-bundle` → Built in 4m 13s.

### Actual inspected image paths and visual observations

Attempt directory: `C:\Users\user\AppData\Local\OSG-Development\cache\evidence\word-native-preview-decoded-export\attempts\20260907083148257-42672-9feff51c`
- `export-at-2p45s.png` / `export-sub-at-2p45s.png` (2.45s, active cue 1, ID `01a07aff0fec71e29221ee0241cbe6a5`): Decoded MP4 video frame shows speaker at zoo in front of elephants; bottom-center subtitle renders `"All right, so here we are in front of the elephants."` in crisp white sans-serif text on a translucent dark pill banner.
- `export-at-0p7s.png` / `export-sub-at-0p7s.png` (0.70s, genuine silent instant): Decoded MP4 frame at 0.70s prior to first speech cue correctly shows no subtitle banner or ghost text; clean video background only.
- `export-at-9p95s.png` / `export-sub-at-9p95s.png` (9.95s, active cue 5, ID `01a07aff0fec71e29221ef4b121c8e07`): Decoded MP4 frame renders `"really really long"` centered with exact matching typography.
- `export-at-17p75s.png` / `export-sub-at-17p75s.png` (17.75s, active cue 9, ID `01a07aff0fec71e29221f07bfb628c66`): Decoded MP4 frame renders `"And that's pretty much all there is to say."`.
- `preview-sub-at-2p45s.png` vs `export-sub-at-2p45s.png`: Visual inspection confirms identical typography, box radius, margins, and text alignment between preview canvas and FFmpeg-rendered export (subtitle-region SSIM 0.909).
- Negative control crops (`export-sub-at-2p45s.png` vs `export-sub-at-9p95s.png` [SSIM 0.512] and `export-sub-at-2p45s.png` vs `export-sub-at-0p7s.png` [SSIM 0.407]): Confirms that comparing different text or text against silence drops SSIM to <0.52 (well below 0.65 threshold), demonstrating the metric is highly discriminating.

### Failed/inconclusive attempts and resolution

- Initial Check A run on a very short fixture completed transcription before the stop button could be actuated; resolved by adopting a 150s media fixture (`ami-IS1009a-60-210.mp4`), allowing deterministic verification of the in-flight `running` job state prior to stop actuation.
- Initial rapid project switch revealed streaming cue bleed into the newly opened project; resolved by invalidating presentation owner refs on media switch and verifying project/cache ownership prior to presentation and completion.
- Controlled `#speech-engine-select` in Check C required native property setters and change event dispatching in the WebDriver harness to properly update React component state; resolved in `wordNativeTranslationVisualCustom.journey.js` and `CreateSubtitlesModal.jsx`.
- Initial follow-up Check B run produced 2 windows instead of 5 because `browser.execute` property assignment on the controlled React range slider did not trigger React's synthetic event handler, leaving window duration at the 120s default; resolved in commit `2592e143` by invoking the native `HTMLInputElement.prototype.value` setter.

### Final normal EXE identity and build provenance

- **Binary path**: `C:\Users\user\AppData\Local\OSG-Development\cache\cargo\package\release\osg-desktop.exe`
- **File size**: 18,799,616 bytes (17.9 MB)
- **SHA-256 hash**: `46409FF23F52197B88BBFA8711AF99A57C4A6CA0EA02FC81CEC2188CDD533FB2`
- **Build lane**: `package` lane via `npm run tauri:build -- --no-bundle`
- **Features**: Built with Rust release profile and `production` feature (`tauri/custom-protocol`).
- **Automation exclusion**: Asserted absence of automation driver (`tauri-plugin-wdio` string search in binary returned `False`; `e2e-automation` feature is excluded from release build).

### Remaining genuine limitations

- **Restart scope**: Retrying a cancelled transcription re-runs the entire selected timeline range rather than selectively scheduling only uncompleted 30s chunks.
- **Local ASR package requirement**: Offline ASR engines (Parakeet, Faster-Whisper, Qwen3) are not bundled in the initial executable installer to keep package size under 20 MB; they must be downloaded by the user through Settings → Tools.
- **Gemini Vision constraints**: Video analysis tasks require container formats supported by the Gemini File API and adhere to standard model upload limits.

### Supervisor verdict — reserved

The supervisor will check this fixed acceptance batch, not demand an open-ended new feature list. New defects discovered may require repair; optional future ideas are not new blockers. The worker must not self-approve this section.
