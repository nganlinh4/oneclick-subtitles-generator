# Engine catalog feasibility

Every ASR engine and narration/speech backend the product ships, with its Windows delivery size,
runtime kind, hardware requirement and a verdict for whether it can be proven end to end on an
ordinary development machine. Every number below is read directly from the reviewed delivery
catalogs, not estimated -- see the cited `file:line` for each row. This is the reference the
`alternateLocalAsrMatrix`, `narrationEngineMatrix` and `edgeTtsNarrationGeneration` E2E journeys
(and their `e2e/inventory.json` entries) cite back to.

## Verdicts

- **PROVABLE-HERE** -- fits comfortably on a development machine, needs no credential, and has (or
  now has) a green or authored real-binary generate-and-verify journey.
- **SIZE-GATED** -- would require completing a multi-gigabyte, multi-part download before a single
  generation could run. Named in exact GiB; see "On download time" below for why this document does
  not also assert a fabricated ETA.
- **HARDWARE-GATED** -- would refuse to run because a specific piece of hardware (a CUDA GPU, a
  DirectML device, Apple's CoreML) is absent. **No catalog entry currently carries this verdict** --
  see "On hardware gating" below.
- **CREDENTIAL-GATED** -- refuses honestly without a stored provider API key/credential, independent
  of package size.

## ASR engines

Catalog: `crates/osg-asr/src/catalog.rs:67-103`. Windows delivery:
`crates/osg-engine-packages/delivery/engine-packages.delivery.json`.

| Engine | Runtime | Download (compressed) | Installed | Verdict |
| --- | --- | --- | --- | --- |
| Faster-Whisper Turbo | CTranslate2 | 4.56 GiB (`sizeBytes` 4,901,460,076, line 218) | 6.73 GiB (`unpackedSizeBytes` 7,224,035,475, line 220) | **PROVABLE-HERE** -- green: `journeys/localAsrGeneration.journey.js` |
| Nvidia Parakeet TDT 0.6B V3 | ONNX | 5.43 GiB (5,829,740,009, line 84) | 7.59 GiB (8,152,315,211, line 86) | SIZE-GATED -- 5.43 GiB larger than the already-proven engine; would only re-exercise the same install/transcribe pipeline |
| Faster-Whisper Large-v3 | CTranslate2 | 5.93 GiB (6,370,629,798, line 343) | 8.10 GiB (8,693,205,194, line 345) | SIZE-GATED |
| Qwen3-ASR 1.7B (+ Qwen3-ForcedAligner-0.6B) | PyTorch | 9.15 GiB (9,822,865,580, line 468) | 11.31 GiB (12,145,438,309, line 470) | SIZE-GATED -- the largest ASR package in the catalog |
| Qwen3-ASR 0.6B (+ Qwen3-ForcedAligner-0.6B) | PyTorch | 6.52 GiB (7,000,370,506, line 710) | 8.68 GiB (9,322,943,679, line 712) | SIZE-GATED |

Every ASR engine shares the same five `asr-runtime-windows-x64-*.zip` parts (~3.27 GiB) as a common
runtime base; the numbers above are each engine's own **total** compressed/installed size including
that shared base, exactly as reported by the catalog (not de-duplicated against an engine that
happens to already be installed).

## Narration / speech backends

Backends: `crates/osg-speech/src/types.rs:11-17` (`SpeechBackend`). Windows delivery:
`crates/osg-speech/delivery/speech-packages.delivery.json`. Frontend card id <-> package id mapping
(only F5-TTS differs): `src/platform/managedEngineCatalog.js:1-33`.

| Backend | Runtime | Download (compressed) | Installed | Credential? | Verdict |
| --- | --- | --- | --- | --- | --- |
| gTTS | Python (network provider) | 10.78 MiB (11,298,854, line 410) | 32.68 MiB (34,262,830, line 412) | none | **PROVABLE-HERE** -- green: `journeys/narrationGeneration.journey.js` |
| Edge TTS | Python (network provider) | 11.18 MiB (11,718,106, line 375) | 33.86 MiB (35,501,479, line 377) | none | **PROVABLE-HERE** -- authored: `journeys/edgeTtsNarrationGeneration.journey.js` (this pass) |
| Gemini Live TTS | Python (network provider) | 19.29 MiB (20,229,035, line 445) | 58.99 MiB (61,856,928, line 447) | **Gemini API key** | CREDENTIAL-GATED -- package itself is tiny; gated at `NarrationMethodSelection.js`'s method radio, `disabled={... !isGeminiAvailable}`, where `isGeminiAvailable = geminiBackendAvailable && credentialAvailability.available` (`src/components/narration/hooks/useAvailabilityCheck.js:216-217`) |
| F5-TTS v1 Base | PyTorch (voice cloning) | 4.28 GiB (4,591,914,866, line 89) | 6.47 GiB (6,946,445,785, line 91) | none | SIZE-GATED -- truthful-status/install-cancel proof only: `journeys/settingsNarrationModelManagement.journey.js` (Model Management tab) and `journeys/narrationEngineMatrix.journey.js` (Tools panel) |
| Chatterbox | PyTorch (voice cloning) | 8.93 GiB (9,589,911,396, line 205) | 11.12 GiB (11,944,441,138, line 207) | none | SIZE-GATED -- the largest narration package in the catalog |

gTTS, Edge TTS and Gemini Live TTS each install standalone (their own small provider runtime, no
shared multi-gigabyte base); F5-TTS and Chatterbox share the same `speech-runtime-windows-x64-*.zip`
parts as each other.

## On hardware gating

Every catalog engine above ships a bundled, CPU-executable runtime (ONNX Runtime, CTranslate2 or
PyTorch's CPU wheels). A repository-wide search of `crates/osg-asr/src`, `crates/osg-speech/src` and
`apps/desktop/src-tauri/src/{asr,speech}.rs` for `cuda`/`gpu`/`directml`/`coreml` (case-insensitive)
finds no capability check, no device-selection command, and no "unsupported on this hardware" state
anywhere in `EngineCard.js`'s state machine (`ready`, `included`, `installed-stopped`,
`not-installed`, `update-available`, `unavailable`, `corrupt`, `checking`) or the native package
status schema (`src/platform/enginePackageService.js`'s `ENGINE_PACKAGE_STATES`). The only mention of
GPU anywhere in this area is `docs/rewrite/DOWNLOADABLE_PAYLOADS.md`'s payload-decision table noting
"a checked GPU dependency closure" for F5-TTS/Chatterbox -- i.e. their bundled PyTorch dependency
closure is reviewed for a GPU-capable build, not that the product refuses to run them without one.
`program.rs:209-210` allowlists `CUDA_VISIBLE_DEVICES`/`PYTORCH_CUDA_ALLOC_CONF` through to the
managed Python worker (so an available CUDA GPU CAN be used if the bundled runtime detects one), but
nothing in this codebase gates installation, activation, or generation on its presence or absence.

Consequently **no catalog entry carries a HARDWARE-GATED verdict**, and `alternateLocalAsrMatrix`/
`narrationEngineMatrix` do not fabricate an "unsupported on this hardware" assertion the product does
not implement -- they record this absence as a finding instead. If hardware-specific runtime
selection is added later, this document and those two journeys are the place to extend.

## On download time

This document intentionally states size, not a download-time estimate, as the primary SIZE-GATED
metric: actual wall-clock download time is network-dependent and was not measured for this pass (per
this lane's "author, do not execute" scope, none of these packages was downloaded to produce this
table). For an order of magnitude: the product's own install flow (`e2e/support/engines.js`'s
`ENGINE_TIMEOUT_MS = 7_200_000`, i.e. 2 hours) budgets up to two hours as a plausible worst case for
completing a single install in the 4.3-6.7 GiB class (Faster-Whisper Turbo, already proven). Every
SIZE-GATED entry above is 4.3-9.2 GiB compressed -- the same order of magnitude or larger -- so a
full install is expected to be on the order of that same multi-hour bound, scaling roughly with size,
not a "quick download" a bounded automated pass should attempt to complete.
