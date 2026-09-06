# E2E Test Infra: OneClick Subtitles Generator Word-Native Transcription

## Test Philosophy
- Opaque-box, requirement-driven. No dependency on implementation design.
- Methodology: Category-Partition + BVA (Boundary Value Analysis) + Pairwise + Real-World Workload Testing.
- All 10 mandatory customer journeys from `WORD_NATIVE_TRANSCRIPTION_HANDOFF.md` verified with pixel inspections and automated machine assertions.

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|---------|---------------------|:------:|:------:|:------:|
| 1 | F01-F04: Domain & Transactional Persistence | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 2 | F05-F10: Specialized Provider & Native Engine | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 3 | F11-F14: Task-First Creation Dialog | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 4 | F15-F20: Editing Surface & Local Regrouping | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |
| 5 | F21-F22: Shared Presentation & Decoded Export | ORIGINAL_REQUEST §R5 | 5 | 5 | ✓ |
| 6 | F23-F24: Verification & Benchmarks | ORIGINAL_REQUEST §R6 | 5 | 5 | ✓ |

## Test Architecture
- Test Runner: WebdriverIO / Playwright (`e2e/journeys/`) and Vitest (`npm test`)
- Rust Unit/Integration Runner: `cargo test --workspace`
- Benchmark Runner: `node scripts/benchmark-gemini-transcribe.mjs`
- Test Output Artifacts: `.system_generated/e2e/`, screenshot folders for all 10 journeys
- Directory Layout: `e2e/journeys/`, `tests/`

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | J1: Fresh video -> Speech -> captions arrival and word click-to-seek | F08, F11, F15, F16 | High |
| 2 | J2: Audio source and selected nonzero range with exact single offset projection | F06, F08, F11 | High |
| 3 | J3: Edit and reflow without regeneration (zero provider calls, undo/redo) | F17, F18 | High |
| 4 | J4: Save / relaunch / migration with intact words, edits, and pre-change project support | F02, F03, F04 | High |
| 5 | J5: Parallel long recording with at least 4 windows, progressive durable output, and seamless boundary joins | F08, F09 | High |
| 6 | J6: Cancel, retry, and project switching without leaks or wrong attachments | F08, F09 | High |
| 7 | J7: Multilingual and speaker tests (Korean/CJK, RTL, repeated words, live diarization namespaces) | F05, F09, F14, F16 | High |
| 8 | J8: Translation and preserved visual/custom tasks | F11, F12, F20 | High |
| 9 | J9: Native preview -> exported file with frame-by-frame decoding and word-highlighting checks | F19, F21, F22 | High |
| 10 | J10: Refusals and truthful recovery (quota, malformed output, model error, missing audio) | F05, F06, F08 | High |

## Coverage Thresholds
- Tier 1: ≥5 test cases per feature area (≥30 feature tests)
- Tier 2: ≥5 boundary & corner tests per feature area (≥30 boundary tests)
- Tier 3: Pairwise coverage of major feature interactions (≥10 interaction tests)
- Tier 4: All 10 mandatory real-app customer journeys with screenshot evidence
- Total minimum: ≥80 test cases across all tiers
