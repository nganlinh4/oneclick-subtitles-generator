# Original User Request

## Initial Request — 2026-09-06T15:50:03Z

Transform OneClick Subtitles Generator (OSG) into a durable, transcript-backed subtitle editor using native Gemini word timestamps, local zero-provider-call caption regrouping, and a unified task-first creation surface, executing the complete implementation contract in docs/rewrite/WORD_NATIVE_TRANSCRIPTION_HANDOFF.md.

Working directory: C:\WORK\oneclick-subtitles-generator
Integrity mode: development

Reference specification: docs/rewrite/WORD_NATIVE_TRANSCRIPTION_HANDOFF.md (and docs/rewrite/GEMINI_VIDEO_RESEARCH.md)

## Requirements

### R1. Native Word-Level Domain and Transactional Persistence
Implement a versioned, durable transcript domain in Rust (`osg-domain`, native persistence) that stores immutable provider word observations (timing offsets, recognized text, speaker IDs, confidence/provenance), turns/segments, and derived caption projections with indexed range access. Projects must persist word-level timing across save, relaunch, and migration without losing words, fabricating timestamps, or expanding giant legacy JSON blobs. Existing cue-only projects must continue to load without data loss.

### R2. Specialized Provider Protocol and Authoritative Native Operation Engine
Implement specialized typed request/stream handling for Gemini `audioTranscriptionConfig` (with `wordTimestamp: true` in VERBATIM mode, language hints, and speaker diarization) in Rust (`osg-gemini`). Move authoritative operation orchestration (physical audio extraction, bounded two-worker window pool, window ranges, capture-to-project offset projection, promotion of staged results, retries, and cancellation) to native Rust. Ensure prompt-based text generation remains clean and separate. Enforce duration parsing with bounded integer arithmetic and documented overshoot projection policies.

### R3. Task-First Creation Dialog and Capabilities Preservation
Replace the legacy transport selector and cluttered Gemini panel with a unified "Create subtitles" creation dialog centered around explicit tasks: Speech (default), Translate, and Visual / Custom. Speech always extracts audio locally. Gemini Transcribe becomes default only after passing quality criteria. Retain and cleanly house all 8 existing capabilities (general speech, lyrics, diarization, direct translation, on-screen text, video description, chaptering, and saved custom prompts/analysis rules) without removing underlying features or leaving hidden legacy paths.

### R4. Transcript & Caption Editing Surface with Local Regrouping
Provide a synchronized editing experience with a compact Transcript / Captions toggle in the editing area. Transcript view must support speaker turns and word click-to-seek. Caption view must support local grouping policies (Natural, Short, One word, Custom) executing entirely offline with zero provider calls. Support manual text corrections, splitting, merging, and edge dragging while preserving raw provenance and explicitly marking unaligned spans. Synchronized word highlighting/reveal must be available as an optional subtitle style for aligned tracks. Translation must generate a linked track referencing source spans without inheriting artificial one-to-one word timestamps.

### R5. Shared Presentation Model Across Preview and Decoded Export
Ensure a single presentation contract governs the editor preview, native video preview, and exported video. Native compositor consumes time-addressable state; seek in either direction, paused frames, and fullscreen scaling must remain exact and non-blinking. Exporters must render aligned word-sync styles accurately and decode real video/audio frames to verify timing, duration, and styling.

### R6. Verification, 10 Required Real-App Journeys, Quality Comparison, and Worker Report
Verify the entire system against the 10 mandatory non-redundant customer journeys in `docs/rewrite/WORD_NATIVE_TRANSCRIPTION_HANDOFF.md`:
1. Fresh video → Speech → captions arrival and word click-to-seek.
2. Audio source and selected nonzero range with exact single offset projection.
3. Edit and reflow without regeneration (zero provider calls, undo/redo).
4. Save / relaunch / migration with intact words, edits, and pre-change project support.
5. Parallel long recording with at least 4 windows, progressive durable output, and seamless boundary joins.
6. Cancel, retry, and project switching without leaks or wrong attachments.
7. Multilingual and speaker tests (Korean/CJK, RTL, repeated words, live diarization namespaces).
8. Translation and preserved visual/custom tasks.
9. Native preview → exported file with frame-by-frame decoding and word-highlighting checks.
10. Refusals and truthful recovery (quota, malformed output, model error, missing audio).

Fill in the "Worker report" section in `docs/rewrite/WORD_NATIVE_TRANSCRIPTION_HANDOFF.md` in place with real evidence, screenshot folders, measured benchmarks, commands run, failures/deviations, and the final production executable identity. Do not self-approve the Supervisor review section.

## Acceptance Criteria

### Core Architecture & Persistence
- [ ] Transcript domain stores stable IDs, high-precision source offsets, recognized spelling, and speaker namespaces in indexed native transactional storage.
- [ ] Opening a saved project recovers word timestamps, speaker labels, manual edits, and alignment states without re-requesting the API.
- [ ] Pre-change project databases load seamlessly without errors, lost tracks, or synthetic word timings.
- [ ] Zero provider network calls occur when switching grouping styles (Natural, Short, One word, Custom) or editing/splitting/merging captions.

### Provider Contract & Engine Ownership
- [ ] Rust owns window scheduling, audio extraction, provider streaming, timestamp validation, and staged promotion; dual frontend scheduler is removed.
- [ ] Provider parsing handles `audioTranscription.words` and speaker diarization parts; invalid, reversed, negative, or overshooting offsets are bounded by documented projection policy.
- [ ] Window retries only target failed intervals and never overwrite existing user-edited captions.
- [ ] Bounded 2-worker window pool preserves cancellation, EOF handling, and credential safety without logging private user text or API keys.

### UI & Creation Flow
- [ ] Single "Create subtitles" dialog opens directly with whole-media or selected-range scope and task selector (Speech, Translate, Visual/Custom).
- [ ] No irrelevant controls (FPS, resolution, prompt, thinking) appear on native transcription tasks.
- [ ] All 8 existing capabilities remain fully reachable through their designated homes without broken entry points.
- [ ] UI follows `material-tokens.css`, enforces focus trap, supports EN/VI/KO and RTL layouts, and excludes pulsing animations.

### Editing & Preview
- [ ] Transcript view displays readable turns with speaker labels; clicking any word seeks the video player to that word's exact native timestamp.
- [ ] Word-synchronized reveal/highlighting displays consistently in both native preview and exported video.
- [ ] Linked translation tracks preserve source transcript links without claiming fake translated word timestamps.

### Verification & Deliverables
- [ ] All 10 customer journeys executed with numbered screenshot folders, pixel-inspected observations, and automated assertions.
- [ ] Benchmark comparison executed against AMI, Cortez singing, and Korean FLEURS fixtures with spread, WER/timing metrics, and documented promotion decision.
- [ ] Production executable built in release configuration without automation dependencies; SHA-256 and absolute path documented.
- [ ] Worker report section in `docs/rewrite/WORD_NATIVE_TRANSCRIPTION_HANDOFF.md` fully completed in place; Supervisor review section left reserved.
