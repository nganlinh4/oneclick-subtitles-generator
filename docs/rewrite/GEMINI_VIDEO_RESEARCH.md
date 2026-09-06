# Gemini media refresh — 2026-09-06

This work is independent of legacy-main parity. Checkpoint before changes:
`9eecdbee` (worktree was clean).

## September 6 follow-up: measured completion and transcription controls

The 1-FPS IS1009a/3.8 real-app run at
`target/subtitle-benchmark/ui-runs/2026-09-06T08-06-01-710Z` completed with STOP,
305 generated words, 85.76% aligned reference coverage and median absolute
caption start/end differences of 545/860 ms. Earlier requests ended mid-JSON
without STOP, including an independent request outside the app parser.
Do not call increased FPS a proven universal fix or accept a truncated response
merely because some complete cue objects arrived. Completion and quality are
separate measurements.

Real-app follow-up runs exercised Korean transcription, Korean-to-Vietnamese
translation, lyrics, OCR, scene descriptions and chaptering. Evidence is under
the `2026-09-06T08-*` UI-run directories. The diarization attempt exposed a
harness visibility error: the option centre was inside the browser viewport
but outside its scrollable menu. The fix scrolls that ancestor normally; it
does not force-click through overlays or change the production dropdown.

### Newly discovered dedicated transcription model

[The transcription guide](https://ai.google.dev/gemini-api/docs/transcribe) and
[its generateContent counterpart](https://ai.google.dev/gemini-api/docs/generate-content/transcribe)
document `gemini-3.5-transcribe`. It produces word annotations rather than
prompt-generated caption timestamps. `wordTimestamp: true` and `diarization`
belong under `generationConfig.audioTranscriptionConfig` on generateContent;
Interactions uses a different transcription-config shape. Smart cleanup and
custom vocabulary cannot be combined with the timestamp path. Do not copy
those controls into ordinary Flash requests.

Live model metadata reports 98,304 input tokens and 32,768 output tokens, not
the general Flash catalog's 1M/65K limits. Both generateContent and its SSE
endpoint returned word annotations; the stream ended with STOP. The measured
60-second meeting result had 86.73% reference coverage and matched-word median
absolute start/end errors of 60/60 ms. The music result had 87.76% coverage and
47/58 ms. These word-level statistics are not directly equivalent to existing
caption-level statistics. Korean has reference text only, so no timing score
is claimed; misrecognized words remain in the result rather than being fixed
from the answer key.

Reproduce with `node scripts/benchmark-gemini-transcribe.mjs 1` (or 20 configured
slots). This is an explicitly billed provider-only benchmark, not a shipping
app journey. References never enter provider requests. There is no retry or
key rotation on quota failure. It preserves per-request evidence and fails
when termination or annotations are absent. Application integration, native
word-to-caption grouping, preset compatibility, cancellation and long-duration
coverage are still required before this model belongs in the shipping picker.

The agentic/static control is independent of media resolution. Agentic
processing must be confirmed by actual processing steps, not inferred from
request acceptance. No agentic production adapter is claimed here.

## Verified sources and decisions

- [Gemini 3.8 model contract](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash):
  stable `gemini-3.8-flash`, audio/video input, structured text output, 1,048,576
  input and 65,536 output tokens. Thinking supports low/medium/high, not minimal.
  SGT's `catalog/model_catalog.json` already includes this endpoint, verified
  September 3. Add as opt-in; do not infer subtitle quality from coding benchmarks.
- [Agentic video announcement](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-agentic-video-in-gemini/)
  and [current API guide](https://ai.google.dev/gemini-api/docs/video-understanding):
  agentic processing is an Interactions video-content setting, not an extra
  generationConfig field for the current generateContent transport. Current
  guide includes 3.8 in addition to the announcement's 3.7/3.6/3.5 Lite.
  Verify processing_call/result evidence, cancellation, stream events, schema,
  uploaded-file cleanup and token accounting before claiming agentic execution.
  Selective retrieval benefits do not prove complete transcription coverage.
- [Audio guide](https://ai.google.dev/gemini-api/docs/audio): audio-only must
  actually send audio media, not video plus an instruction to ignore the image.

## App and harness audit

The existing Rust benchmark shares upload/stream transports, but copies prompts
and schemas and bypasses desktop clip preparation, project admission, streaming
parse, timestamp restoration and persistence. Keep it as a provider baseline;
do not call it a product-workflow benchmark.

SGT's useful rule: benchmark the production entry point, not a separately rebuilt
HTTP payload. Record failed attempts and full-result latency, rotate configured
credentials without treating shared-project keys as independent quota, and never
compare results with different request/scorer fingerprints.

Existing speech-envelope references use silencedetect. Those are not human cue
boundaries or sufficient ground truth for word-aligned timestamp accuracy.

## Dataset review

- [AMI](https://groups.inf.ed.ac.uk/ami/download/) supplies real video and manual
  word annotations under CC BY 4.0. Suitable for timed dialogue/overlap fixtures.
- [How2](https://github.com/srvk/how2-dataset) supplies instructional video and
  aligned text, but maintainers report many original videos removed. Do not base
  deterministic acceptance on a downloader that silently substitutes sources.
- TED-derived data needs a separate usage review; do not assume transcripts or
  original videos inherit a dataset website's code license.

Prepared three AMI excerpts: ES2004a (60 seconds), ES2002a (90 seconds),
IS1009a (150 seconds), with 94/161/291 manually timed words. Source media,
annotation archive, generated clips and references are hashed in
`target/subtitle-benchmark/real-video/manifest.json`; preparation is reproducible
through `scripts/prepare-ami-video-benchmark.py` after obtaining the sources.
The first contact sheet was visually inspected. These vary meeting/site/speakers
but remain English meeting speech: not a multilingual or music quality claim.

## Measured provider baseline and root fixes

The initial live baseline used all 20 configured credential slots across 72
cells and six models: 65 valid outputs, six HTTP 429 failures, one timestamp
parse failure. Its successful test-process exit is NOT an all-green result.
Results: `target/subtitle-benchmark/runs/2026-09-06-provider-baseline`.
The silence case also exposed hallucinations outside the app's silence policy.
These are provider-level observations, not proof of production workflow quality.

Request audit found the native path did not transmit the FPS control. FPS is now
validated and serialized on video parts only, including the old generation path.
Timestamp projection previously guessed the origin again as streaming rows grew;
the fixed contract is clip-local timestamps projected once into the project.
Streaming previously reparsed accumulated JSON and could publish a stale pending
update after completion/error. It now scans newly appended records and cancels
pending updates at terminal states. The September 6 matrix below now supplies
real UI proof for the tested clips, not an hour-long speech guarantee.

The opt-in `e2e/scenarios/geminiMediaBenchmark.mjs` drives the actual modal and
records saved cues, text-aligned timing scores, partial-cue observations and
screenshots. Arguments select case/model/mode (or `all`). Human references remain
in the Node scoring process and are never passed to the app/provider.

## Remaining acceptance (not claimed complete)

### September 6 real-app baseline and preset audit

The unchanged `d0c8c888` binary completed 36/36 customer workflows: three AMI
clips, six models, video and audio-only. Every cell observed partial cues before
completion, saved real results and captured native preview screenshots. Evidence:
`target/subtitle-benchmark/ui-runs/2026-09-05T20-15-15-371Z`.
This is **workflow success, not transcription quality success**. Human references
were withheld from requests. All clips are English meetings, with overlapping
speech and different sites/speakers; they do not represent every media genre.

Observed reference-word coverage ranged from 15.5% to 89.3%. In particular,
3.8 video on IS1009a produced only 58 words against 309 reference words (15.5%
matched coverage), whereas its audio-only run covered about 87%. The cause of
this individual omission is not yet established from the saved-cue evidence.
3.5 audio on ES2004a had median absolute start/end errors of 5250/5360 ms.
Small timing errors on the matched subset must never compensate for missing
speech. No benchmark-specific offsets, transcripts or tuned pass thresholds
were fed back into prompts. The default model remains unchanged.

A second run forced the 150-second IS1009a clip into three balanced windows,
using 3.1 Flash Lite in both modes. Exactly three jobs succeeded, with partial
cues observed while work remained. Video coverage was 84.5%, median absolute
start/end error 295/295 ms; audio coverage was 86.4%, error 214/267 ms.
Evidence: `target/subtitle-benchmark/ui-runs/2026-09-05T20-48-29-958Z`.
These are single-run observations, not statistically established model rankings.
The provider baseline explicitly rotated all 20 configured slots; the UI matrix
enrolled them but did not measure which slots were selected, so it does not
establish additional per-slot coverage.

The subsequent preset revision is intentionally outside that baseline: concise
task-specific instructions, independent translated descriptions, no sample
dialogue, no invented speaker identities, whole-media coverage and actual media
timing rather than word-count-derived timing. Chapters retain their boundaries
instead of being auto-split into captions. Translation requires a target
language. Saved custom prompts are not rewritten. Preset quality improvement
still needs a post-change live comparison, not merely prompt-string tests.

Fixed daily request-count suffixes were removed from model selectors: current
[Google rate-limit documentation](https://ai.google.dev/gemini-api/docs/rate-limits)
states that limits depend on project/tier, not individual API keys. Twenty keys
must not be treated as twenty independent quota pools.

Fixture preparation now refuses reuse when an existing clip's hash, source
hashes, range or camera disagree with its receipt. It cannot silently assign
fresh provenance to stale video bytes.

Additional audit: the legacy timestamp parser matched arbitrary three-number
strings before HH:MM:SS, and read decimal fractions as integer milliseconds.
It now parses only explicit unit/colon forms, preserves hours/fraction precision,
and rejects invalid input rather than returning zero. Streaming auto-split IDs
are sequential across appended records and checked against the final parse.

Live Interactions probes (public synthetic text, store=false): v1beta with a
schema object returned HTTP 200; v1beta2 from the migration guide returned an
HTML HTTP 404. v1beta unstructured streaming returned actual step.start/delta/stop
and interaction.completed events; structured streaming returned HTTP 500 twice.
Do not turn this into a silent non-streaming fallback or claim agentic support.
The guide and migration examples are inconsistent; preserve these observations
and verify the exact transport before changing the production API.

- Exercise audio-only in the hidden real app, including full/partial range,
  multiple windows, cancellation, no-audio refusal and retry. Confirm uploaded
  MIME and artifact stream inventory without logging bytes/keys.
- Complete preset/settings/localization and token-estimation review. Preserve
  explicit mode through every retry and automatic-generation path.
- Use three reviewed videos through the production operation and compare both
  modes across every available media model. Record credential-slot coverage.
- Score text-aligned timing: signed start/end bias, median and p95 absolute
  error, missing/extra speech, text accuracy and drift versus time. Do not pair
  reference and output cues merely by array index or hide mismatches.
- Evaluate agentic Interactions separately before promoting it to production.
- Build and inspect the updated UI in the hidden real app; existing executable
  does not yet contain these changes.
