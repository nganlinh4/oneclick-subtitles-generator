# Engine catalog feasibility

Which downloadable ASR and narration engines can be proven end to end on an ordinary development
machine. Sizes are the Windows totals recorded in
`crates/osg-engine-packages/delivery/engine-packages.delivery.json` and
`crates/osg-speech/delivery/speech-packages.delivery.json`; re-read them there when they change.
The `alternateLocalAsrMatrix`, `narrationEngineMatrix` and `edgeTtsNarrationGeneration` journeys
cite this page.

- **Provable here**: small, credential-free, and covered by a real generate-and-verify journey.
- **Size-gated**: needs a multi-gigabyte download before one generation can run, so journeys prove
  only truthful status and install-then-cancel.
- **Credential-gated**: refuses honestly without a stored API key.

## ASR

| Engine | Download | Verdict |
| --- | --- | --- |
| Faster-Whisper Turbo | 4.56 GiB | Provable here (`localAsrGeneration`) |
| Parakeet TDT 0.6B v3 | 5.43 GiB | Size-gated |
| Faster-Whisper Large-v3 | 5.93 GiB | Size-gated |
| Qwen3-ASR 0.6B + aligner | 6.52 GiB | Size-gated |
| Qwen3-ASR 1.7B + aligner | 9.15 GiB | Size-gated |

All five share the same ~3.27 GiB runtime parts; the sizes above include them.

## Narration

| Backend | Download | Verdict |
| --- | --- | --- |
| gTTS | 10.8 MiB | Provable here (`narrationGeneration`) |
| Edge TTS | 11.2 MiB | Provable here (`edgeTtsNarrationGeneration`) |
| Gemini TTS | 19.3 MiB | Credential-gated (needs a Gemini key) |
| F5-TTS v1 Base | 4.28 GiB | Size-gated; F5 weights are CC-BY-NC-4.0 |
| Chatterbox | 8.93 GiB | Size-gated |

## No hardware gate

Every engine ships a CPU-capable runtime. Nothing in the product checks for CUDA, DirectML or CoreML
before installing or running an engine (the worker environment only passes CUDA variables through),
so no journey asserts an "unsupported hardware" state. If hardware-specific selection is added,
extend this page and those journeys.
