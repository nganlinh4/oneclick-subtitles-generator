# Final bounded acceptance closeout

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

Status: NOT STARTED. Supervisor acceptance: NOT REVIEWED.

| Required check | Passed / failed / inconclusive / externally blocked | Actual binary source/hash | Attempt and decisive evidence | Exact limitation |
| --- | --- | --- | --- | --- |
| A: stop + successful retry/restart | Not run | — | — | — |
| A: active A → project B isolation | Not run | — | — | — |
| B: nonzero range + four windows | Not run | — | — | — |
| C: ordinary model executes | Not run | — | — | — |
| C: translation executes | Not run | — | — | — |
| C: video-dependent task executes | Not run | — | — | — |
| C: local ASR routing/status | Not run | — | — | — |
| D: decoded subtitle-region comparisons and negative control | Not run | — | — | — |

Below the table record only: root fixes and commits; exact commands/results; actual inspected image paths and observations; failed/inconclusive attempts and resolution; final normal EXE identity and build provenance; remaining genuine limitations. Keep the report concise and reproducible. No certification adjectives or conflation of unit tests with live customer actions.

### Supervisor verdict — reserved

The supervisor will check this fixed acceptance batch, not demand an open-ended new feature list. New defects discovered may require repair; optional future ideas are not new blockers. The worker must not self-approve this section.
