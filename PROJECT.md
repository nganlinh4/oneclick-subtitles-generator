# Project: OneClick Subtitles Generator (OSG) Word-Native Transcription

## Architecture
- **Layer 1: Speech Recognition & Provider Wire Protocol (`crates/osg-gemini`)**
  - Typed `audioTranscriptionConfig` (`wordTimestamp: true`, diarization, language hints).
  - Strict separation of transcription requests from prompt/thinking/video parameters.
  - Bounded integer duration parsing (nanosecond precision) and 100ms overshoot projection policy.
- **Layer 2: Authoritative Native Operation Engine (`apps/desktop/src-tauri`, `osg-media-pipeline`)**
  - Rust-owned window planning, 16kHz mono audio extraction, bounded 2-worker pool (`tokio::sync::Semaphore(2)`).
  - Single capture-to-project offset projection, window namespacing (`w{index}:{speaker}`).
  - Staging area with atomic promotion and targeted window retries without touching user-edited captions.
- **Layer 3: Native Word Domain & Transactional Persistence (`crates/osg-domain`, `crates/osg-infrastructure`)**
  - Immutable provider word observations (`TimedWord`), turns (`TranscriptTurn`), derived caption projections (`CaptionProjection`).
  - Additive SQLite migration `0015_word_native_transcripts.sql` with indexed range access.
  - Backward compatibility for legacy v1-v14 cue-only projects without synthetic word timings.
- **Layer 4: Task-First UI & Creation Surface (`src/components`)**
  - Unified "Create subtitles" modal with 3 tasks (`Speech`, `Translate`, `Visual / Custom`).
  - Preserves all 8 existing capabilities in clean homes.
  - Strict Material Design 3 tokens (`material-tokens.css`), RTL/i18n (EN/VI/KO) support.
- **Layer 5: Transcript & Caption Editing Surface (`src/components/lyrics`, `crates/osg-asr`)**
  - Compact `[Transcript | Captions]` segmented toggle.
  - Transcript view with speaker turns and word click-to-seek.
  - 100% offline zero-network-call local regrouping (`Natural`, `Short`, `One word`, `Custom`).
  - Word-synchronized reveal/highlighting styles and linked translation tracks.
- **Layer 6: Shared Presentation & Decoded Export (`crates/osg-scene`, `crates/osg-compositor`, `crates/osg-export`)**
  - Single time-addressable presentation contract across preview canvas and native export compositor.
  - Non-blinking seek/pause/scaling and frame-by-frame export verification.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | F01: Rust Word Domain Types | `TranscriptRevision`, `TimedWord`, `TranscriptTurn`, `CaptionProjection` in `osg-domain` | M1 | Spec R1 |
| 2 | F02: Additive SQLite Migration v15 | `transcript_revisions`, `transcript_words`, `transcript_turns`, `cue_word_mappings` with range indices | M1 | Spec R1 |
| 3 | F03: Pre-Change Project Compatibility | Seamless load of legacy v1-v14 projects as cue-only without synthetic word timings | M1 | Spec R1 |
| 4 | F04: Transactional Project Persistence | Word timing preservation across save, relaunch, export, and migration | M1 | Spec R1 |
| 5 | F05: Provider Wire Contract in `osg-gemini` | `gemini-3.5-transcribe`, `audioTranscriptionConfig` with `wordTimestamp: true`, diarization, language hints | M2 | Spec R2 |
| 6 | F06: Duration Parsing & 100ms Overshoot Policy | Bounded integer parsing into nanoseconds, clamping up to 100ms, quarantine >100ms | M2 | Spec R2 |
| 7 | F07: Strict Provider Separation | Clean exclusion of prompt schemas, visual FPS, resolution, thinking from transcription requests | M2 | Spec R2 |
| 8 | F08: Authoritative Native Operation Engine | Rust-owned orchestration, 16kHz mono audio extraction via `osg-media-pipeline`, single capture-to-project offset projection | M2 | Spec R2 |
| 9 | F09: Bounded 2-Worker Window Pool | Concurrency = 2, window namespacing `w{index}:{speaker}`, staging, atomic promotion, targeted window retries | M2 | Spec R2 |
| 10 | F10: Dual Frontend Scheduler Removal | Elimination of JS-side window slicing and cue merging in `GeminiAdapter.js` | M2 | Spec R2 |
| 11 | F11: Task-First Creation Dialog | Unified modal with `Speech`, `Translate`, `Visual / Custom` tabs, scope selector Whole vs Selected Range | M3 | Spec R3 |
| 12 | F12: Preservation of All 8 Capabilities | General speech, lyrics, diarization, translation, on-screen text, description, chaptering, custom rules | M3 | Spec R3 |
| 13 | F13: Removal of Irrelevant UI Controls | Removal of FPS, resolution, prompt box, auto-split word sliders, token counts from Speech task | M3 | Spec R3 |
| 14 | F14: UI Visual & Styling Discipline | `material-tokens.css`, focus trap, EN/VI/KO/RTL support, no pulsing animations | M3 | Spec R3 |
| 15 | F15: Compact Transcript / Captions Switcher | Segmented toggle in editor header | M4 | Spec R4 |
| 16 | F16: Transcript View with Speaker Turns & Click-to-Seek | Turns, editable speakers, clickable words seeking video player to exact native timestamp | M4 | Spec R4 |
| 17 | F17: Offline Zero-Provider Regrouping | Instantaneous local regrouping (`Natural`, `Short`, `One word`, `Custom`), zero network calls | M4 | Spec R4 |
| 18 | F18: Provenance Preservation & Manual Editing | Word split/merge/drag, raw observation preservation, unaligned span tagging | M4 | Spec R4 |
| 19 | F19: Word-Synchronized Reveal & Highlighting Style | Optional synchronized word reveal/karaoke style for aligned tracks | M4 | Spec R4 |
| 20 | F20: Linked Translation Tracks | Target cues linked to source word spans without fake 1-to-1 word timestamps | M4 | Spec R4 |
| 21 | F21: Shared Presentation Contract | Time-addressable presentation model for preview and export, exact non-blinking seek/pause/scaling | M4 | Spec R5 |
| 22 | F22: Word-Synchronized Decoded Export | FFmpeg export rendering exact word-sync styling with frame-by-frame verification | M4 | Spec R5 |
| 23 | F23: 10 Real-App Customer Journeys Execution | Execution, pixel inspections, screenshots, and automated assertions for all 10 journeys | M5 | Spec R6 |
| 24 | F24: Quality Benchmarking & Worker Report | AMI, Cortez singing, Korean FLEURS fixtures, WER/timing metrics, release build, and Worker report completion | M5 | Spec R6 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Native Word Domain & Transactional Persistence | `crates/osg-domain`, `crates/osg-infrastructure` (F01–F04) | none | DONE |
| M2 | Specialized Provider Protocol & Native Operation Engine | `crates/osg-gemini`, `apps/desktop/src-tauri`, `src/services/engines` (F05–F10) | M1 | DONE |
| M3 | Task-First Creation Dialog & Capabilities Preservation | `src/components`, `src/styles` (F11–F14) | none | DONE |
| M4 | Editing Surface, Local Regrouping & Presentation | `src/components/lyrics`, `crates/osg-asr`, `crates/osg-scene`, `crates/osg-compositor`, `crates/osg-export` (F15–F22) | M1, M2 | DONE |
| M5 | Final E2E Test Pass, 10 Customer Journeys, Benchmarks & Delivery | All targets, E2E test suite pass, 10 journeys, benchmarks, release build, worker report (F23–F24) | M1, M2, M3, M4, TEST_READY | PLANNED |
| ME2E | E2E Testing Track | Independent requirement-driven opaque-box test suite (Tiers 1–4) publishing `TEST_READY.md` | none | DONE |

## Interface Contracts
### `osg-domain` ↔ `osg-infrastructure`
- `TranscriptRevision`: contains `revision_id: Uuid`, `project_id: ProjectId`, `created_at: i64`, `words: Vec<TimedWord>`, `turns: Vec<TranscriptTurn>`.
- `TimedWord`: `id: WordId`, `text: String`, `start_ms: i64`, `end_ms: i64`, `speaker_id: Option<String>`, `confidence: Option<f32>`, `is_unaligned: bool`.
- `TranscriptTurn`: `turn_id: TurnId`, `speaker_id: String`, `start_ms: i64`, `end_ms: i64`, `word_ids: Vec<WordId>`.
- `CaptionProjection`: `cues: Vec<SubtitleCue>`, `cue_word_mappings: Vec<(CueId, Vec<WordId>)>`.
- SQLite schema v15: tables `transcript_revisions`, `transcript_words`, `transcript_turns`, `cue_word_mappings`.

### `osg-gemini` ↔ Native Operation Engine (`src-tauri`)
- `ModelKind::Gemini35Transcribe` ("gemini-3.5-transcribe").
- `AudioTranscriptionConfig { word_timestamp: bool, diarization: bool, language_hints: Vec<String> }`.
- `Part::audio_transcription: Option<AudioTranscription { words: Vec<TranscriptionWord> }>`.
- `TranscriptionWord { word: String, start_offset: Duration, end_offset: Duration, speaker_label: Option<String> }`.
- Engine: Bounded 2-worker window pool via `tokio::sync::Semaphore(2)`. Single offset projection: `project_start_ms = window_start_ms + word_start_offset_ms`. 100ms clamp for provider end-overshoot.

### Local Regrouping & Presentation (`src/components/lyrics`, `crates/osg-scene`, `crates/osg-export`)
- Local Regrouping Policies: `Natural` (pause > 300ms, sentence punctuation `[.?!]`, max 12 words), `Short` (max 5 words or 2.5s), `One word` (1 word per cue), `Custom` (user sliders for max words / max duration). Offline, zero provider calls.
- `CueRun`: maps glyph cells to word timing offsets.
- `AnimationType::WordReveal` and `AnimationType::WordHighlight` evaluate active words at playback/export time `t`.

## Code Layout
- Backend Domain: `crates/osg-domain/src/`
- Backend Infrastructure & Migrations: `crates/osg-infrastructure/src/storage/`
- Backend Gemini Provider: `crates/osg-gemini/src/`
- Backend Operation Engine: `apps/desktop/src-tauri/src/`
- Backend Scene & Compositor: `crates/osg-scene/src/`, `crates/osg-compositor/src/`
- Backend Export: `crates/osg-export/src/`
- Frontend Components: `src/components/`
- Frontend Lyrics & Transcript Surface: `src/components/lyrics/`, `src/components/LyricsDisplay.js`
- Frontend Stores & Services: `src/platform/`, `src/services/`
- E2E Tests & Journeys: `e2e/`, `tests/`
