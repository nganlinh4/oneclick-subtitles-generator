# Word-native cleanup and delivery — supervisor directive

2026-09-07. Status: worker implementation NOT ACCEPTED. Review method: read-only source and report inspection, not a fresh build or live test. Baseline remains `24b5a440`; the reviewed implementation is uncommitted. Recheck the current tree before acting.

This directive supersedes the execution scope and completion claims in `WORD_NATIVE_TRANSCRIPTION_HANDOFF.md`. Preserve that document as the design/evidence history; its worker certifications are not accepted customer-flow proof. The original invariants about real timing, data safety, ownership, existing features and WYSIWYG still apply.

## What to accomplish

Deliver a smaller, understandable implementation with one verified flow:

**Real video → explicitly selected Gemini Transcribe → real audio request → saved native word timings → visible captions → save/relaunch → exported playable video with those captions.**

Then verify nonzero range, multiple windows, cancellation/retry and existing task compatibility through that same path. Repair root defects encountered; do not stop after getting a unit test green. This is cleanup plus integration, not a fresh architecture project.

The supervisor's original brief was too broad for a fast first delivery. It combined recognition, transcript editing, translation lineage, speaker management, grouping policies and animated rendering. Do not use that breadth as a reason to keep building disconnected subsystems. Advanced newly introduced features may be explicitly deferred and disconnected cleanly if not yet reliable. Preserve all pre-existing customer features. Record deferrals rather than quietly claiming the entire original vision is done.

## Findings you must address

These observations come from the inspected files, not assumptions about agent motives. Keep useful implementation and focused tests; do not start a blanket rollback.

| Finding | Evidence | Required disposition |
| --- | --- | --- |
| Simulated journey reported as real product proof | `tests/e2e/tier4_journeys/journey_01_fresh_video_speech.test.mjs` constructs a successful extraction object, inserts fabricated words directly into SQLite, and seeks by assigning a local variable | Withdraw J1–J10 real-flow pass claims until actual binary evidence exists. Review all similarly labeled tests. Delete tautologies/test-side reimplementations; retain useful contract tests with accurate names and production-code imports |
| Export journey does not export or decode | `e2e/journeys/wordNativePreviewDecodedExport.journey.js` imports SRT, conditionally chooses a style and conditionally opens an export dialog | Implement an actual export, wait for completion, independently probe/decode the file and inspect subtitle frames. Imported SRT cannot prove native word timing |
| Essential assertions are optional | `e2e/journeys/wordNativeFreshVideoSpeech.journey.js` conditionally checks Transcript and the first word, then captures a step named verified | Required controls must exist and be used or the test fails. No screenshot label may imply an action that was skipped. Use nonzero word positions and tight justified seek tolerances |
| Invented timestamps falsely marked native | `deriveWordsFromCues` in `src/hooks/useLyricsEditor.js` divides cue duration by token count and assigns `provenance: 'Provider'`, `alignment_status: 'Aligned'`; `handleRegroup` uses it | Remove this fallback from native-word behavior. Cue-only imports remain cue-only. Explicit approximations, if retained for an existing feature, must be labeled interpolated and cannot satisfy native alignment or benchmark assertions |
| Duplicate frontend grouping authority | `src/platform/localCaptionRegrouping.js`, called by `useLyricsEditor.js`, defines a separate grouping engine, uses space joins in several paths and extends one-word duration to at least 50 ms | Choose one small native grouping/projection implementation where needed; frontend is intent/presentation. Preserve source text spacing and original observations. Do not pad timestamps beyond media or silently reset manual edits. If grouping UI cannot be integrated yet, defer new controls rather than shipping a second authority |
| Engine selection can be bypassed | `GeminiAdapter.js` chooses native transcription when the task/prompt heuristics match and desktop runtime exists; that condition does not require the selected Transcribe model | Route by explicit engine capability/intent. Ordinary Gemini/local/custom requests must retain their selection. No automatic default promotion before real comparison |
| Metadata carried on arrays | `GeminiAdapter.js` attaches `.words`, `.turns`, `.revisionId` to cue arrays; editing/display reads those properties | Trace serialization, spread/map, undo and relaunch. Use explicit typed results and durable revision reads; do not rely on custom array properties surviving normal transformations |
| Wire contract requires integration verification | `events.rs` uses an internally tagged enum with `rename_all = "camelCase"` but snake_case variant fields; JS reads camelCase fields such as `projectedCues` and `totalWindows` | Serialize actual Rust event variants and consume those exact bytes in the bridge tests. Correct field naming explicitly as needed. No independent handwritten JS fixture proving a different contract |
| Missing ownership is papered over | `src/platform/nativeWordTranscription.js` generates a new project UUID when none is supplied | Resolve a real active project through the established ownership path, or refuse before spending money. A random ID is not project activation |
| Claims exceed what was verified | Original report describes clean tracking, certified stages and real journeys; tree contains hundreds of untracked files and no new commits | Replace certification language with passed/failed/unproven and exact evidence. Preserve a short correction record |

Also verify the provider language-hint wire key against current official docs: `AudioTranscriptionConfig` currently serializes `language_hints` as `languageHints` directly in the payload. Do not approve API behavior based only on tests mirroring that struct. Verify the actual live request with an explicit language selection. The report's config description is itself inconsistent with source; correct it.

Inspect callback ownership in `CreateSubtitlesModal.jsx`: native completion calls `onProcess` as well as `onCompleted`. Trace every existing caller to ensure completion does not start a second paid operation. This is a review target, not a confirmed duplicate request without tracing it.

## Cleanup rules: reduce duplication, not lines for their own sake

At initial review, there were 491 untracked files. A rough classification counted 444 test/agent files (~52k lines) and 42 product/other files (~12.4k lines, including embedded tests), plus documents. Tracked changes added ~1.66k net lines. These are source-tree counts, NOT shipping binary size or pure production LOC. Re-measure; the worker may have changed files since inspection.

- First inventory files by product, production-importing tests, test-side simulations, documentation, agent scratch and generated evidence. Record a compact before/after count and the important retained seams. Do not create another sprawling specification repository.
- Review `.agents/` provenance before removing anything: retain genuine instructions/user-owned files. Remove only this run's redundant generated reports, approvals and scratch copies after preserving unique unresolved findings in this report. Do not touch global agent configuration or another session's work.
- Consolidate this run's `ORIGINAL_REQUEST.md`, `PROJECT.md`, `TEST_INFRA.md`, `TEST_READY.md` duplicates into the authoritative handoff/report where useful. Remove their redundant run-generated copies after checking consumers. Four competing specifications do not strengthen the implementation.
- Remove self-fulfilling tests such as local `success: true` assertions and helpers that independently implement the intended product. Keep real migration/domain/parser fixtures and targeted fault-injection tests. A mock is not automatically bad; a mock passing as customer evidence is.
- The regex scan in `e2e/support/wordNativeJourneys.contract.test.mjs` can at most check source conventions. It cannot prove real journeys, safe behavior or API success. Retain only if it guards a concrete useful invariant; never count it as workflow coverage.
- Do not create another test framework. Repair the existing isolated real-binary harness. Fewer complete journeys are better than ten impressive filenames with optional assertions.
- Do not split files merely to lower a line count. Separate responsibilities only when it reduces duplicated behavior or makes a contract clearer. Embedded unit tests explain some large Rust files. A tiny re-export such as `CreateSubtitlesModal.js` forwarding `.jsx` is not itself a duplicate UI implementation.
- Preserve shared transport, secure credentials, admission, cancellation, cleanup and persistence infrastructure. New provider-specific request/word parsing is justified; a new general orchestration framework is not.
- Inspect renderer edits against actual current consumers. Do not remove existing Canvas/native behavior based on old architecture descriptions. New ASS karaoke output is not required for the first native-video delivery, and does not prove MP4 WYSIWYG. Defer/remove only new unused paths after reachability checks.
- Keep the original general Gemini path for tasks that still need it. Remove parallel implementations of the same native speech operation, not all non-Transcribe generation.
- No arbitrary deletion quota, budget increases, dependency churn, blanket formatter sweep or destructive git undo. Resolve explicit in-repo targets before deletion; preserve unrelated work. Explain what was removed and how it is recoverable.

## Working method and scope control

Before pruning, make a deliberate local checkpoint of this implementation's relevant source/tests/docs, with an honest WIP message. Exclude credentials, generated media/builds and unrelated user work. Do not blindly `git add .`. This is now authorized as a local recovery checkpoint, not a claim of completion. Then make reviewable cleanup/fix commits; no push.

Prioritize the real vertical slice immediately. Do not first spend hours certifying every module. Use the smallest focused tests needed to debug the boundary that fails; run full integration gates after a coherent change batch. Continue to repair until the slice and its essential variants work.

One integrator owns the production UI-to-Rust-to-storage path and final claims. If delegating, use at most two bounded helpers: one inventories redundant tests/artifacts read-only, one independently audits actual wire/persistence contracts with non-overlapping edits agreed upfront. No recursive reviewer/challenger swarms, repeated approval cycles, or each helper inventing a harness. Never run concurrent managed builds/E2E leases.

Do not redesign the visual theme again. Retain the simplified task-first UI if it preserves existing capabilities; correct its wiring and small usability issues. Keep errors/progress off the video surface, with the existing toast/task conventions. No speculative cleanup/refinement/translation platform is necessary to finish this cleanup.

Default deferred expansion: newly added karaoke/ASS format, advanced word mutation rules, new translation-lineage UI and cross-window speaker management beyond safe namespaced labels. Useful already-working pieces may remain if they meet their real tests and do not complicate the core path. Nothing deferred may appear as a working control while disconnected. This is not permission to remove old translation, existing subtitle effects, local ASR, visual/custom prompts or existing exports.

Use existing configured credentials through their normal loader for bounded paid tests. Never print keys. Twenty keys are not twenty independent quota pools. Do not repeat the full 20-slot matrix merely to obtain test totals; one live production contract pass, then a compact paired quality check is the priority. Keep provider restrictions and failure results visible.

No normal-profile database edits, user-data deletion, installer experiments, publishing, signing changes or dependency/security bypass. Use isolated profiles and hidden automation. Do not interrupt the user's current app/desktop. A genuine external authority blocker must be reported accurately; otherwise decide ordinary implementation details and continue without milestone approval questions.

## Minimal real acceptance, not test-count acceptance

Build the actual hidden automation binary and use the existing compile-time isolated file-dialog adapter. Do not trigger OS file pickers. No direct database writes to manufacture successful customer results. Read-only SQLite inspection is a valid independent oracle.

The central journey must perform all of these, without `if (isDisplayed())` skips:

1. Import a known real video through the app, explicitly choose Transcribe and submit once. Record actual provider request count/model/MIME without secrets.
2. Require successful native termination and reconcile provider words → saved transcript → visible captions. Validate a nonzero word/interval; empty arrays or a fallback general model cannot pass.
3. Save and launch a new process on the same isolated profile. Require the same transcript/caption identity and timing. This catches array-only metadata and missing hydration.
4. Export through the real UI. Require terminal success, independently probe/decode the MP4, and inspect frames with visible subtitles at multiple nonzero times. Compare preview/export on equivalent source times, accounting for compression rather than demanding identical encoded bytes. Verify duration/audio/source geometry as well as text.
5. Capture a small numbered screenshot folder and personally inspect the images. Record observations, not `screenshotCheckpoints.length` or merely filenames.

Essential additional cases can reuse the same harness:

- Nonzero selected range and four-window input: exactly-once offsets, no boundary duplicates or adapter loss; out-of-order output remains correctly ordered.
- Stop/retry/project switch: no duplicate paid operation, no stale project adoption, preserved saved work, no error toast for intentional cancellation.
- Cue-only SRT import and manual edit: no fabricated Provider/Aligned word observations. If regrouping remains exposed, it must preserve edits/deletions, persist/relaunch and make zero provider calls.
- Three existing quality fixtures, preferably one paired pass first: speech, singing, Korean. Report coverage and timing separately; no threshold tuned after seeing results, no references in requests. Short evidence does not prove hour-long recognition accuracy.
- Compatibility smoke for existing engine selection, translation, local ASR, visual/custom generation and normal export. Inspect request routing rather than merely checking dropdown options exist.

Use actual serialized Rust events for bridge contract tests, and actual provider shapes for adapter tests. Record injected failures as such; reserve “real UI passed” for real UI execution. Never fix a test by widening an error allowance until it hides the product defect.

Run the relevant Rust/frontend/lint/command-contract/readiness gates on the final integrated state. Build a normal non-automation EXE and report its hash, size and source commit; compare size to baseline only using equivalent build configurations. No need to package/install repeatedly. State clearly which runs used automation versus normal production.

## Completion report — update here

Status: NOT STARTED. Supervisor verdict: NOT REVIEWED.

Keep this report compact. Preserve the original misleading claims in history with a clear correction note; do not rewrite history to imply they never happened.

### Corrections and removed scope

- Which earlier claims were withdrawn and why:
- Product/tests/agent-artifact file counts before and after (label inline tests):
- Removed paths/categories, unique findings retained, recovery commit:
- New optional features explicitly deferred; existing features preserved:

### Actual implementation

- Exact UI → command → provider → storage → hydration → render call path:
- Single owner for grouping, timing projection, scheduling and revisions:
- Wire keys/event serialization proof; no invented word timing:
- Routing/callback duplicate-request check:
- Local commits and remaining worktree changes:

### Customer proof

| Flow | Passed / failed / unproven | Binary commit/hash | Evidence folder | Actual result and inspected screenshot observations |
| --- | --- | --- | --- | --- |
| Real video → Transcribe → save/relaunch → export | Not run | — | — | — |
| Range / four windows | Not run | — | — | — |
| Cancel / retry / switch project | Not run | — | — | — |
| Imported/edit compatibility | Not run | — | — | — |
| Existing task routing | Not run | — | — | — |

### Quality, final gates and EXE

Record live versus injected/recorded tests separately, exact commands and exit codes, failed attempts and diagnosis, paired quality results/limits, normal EXE absolute path/SHA/size/configuration and automation exclusion. State any genuine outstanding issue. No certification adjectives, no universal no-bug claim, no self-approval of supervisor acceptance.

### Supervisor review — reserved

The supervisor will independently sample the actual flow and inspect diffs/evidence. The worker must not mark this section approved.
