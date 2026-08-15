# Benchmark fixture sources

Protocol 1 deliberately combines independent corpora instead of treating one
recording style as representative.

## Mini LibriSpeech

Mini LibriSpeech `dev-clean-2` (OpenSLR SLR31) provides clean read speech and
controlled codec/noise/timing derivatives. OpenSLR describes it as a
LibriSpeech subset intended for regression testing and publishes it under CC
BY 4.0.

- Source page: https://www.openslr.org/31/
- Archive: `dev-clean-2.tar.gz`
- Archive MD5: `6d7ab67ac6a1d2c993d050e16d61080d`
- License: Creative Commons Attribution 4.0 International
- Original corpus authors: Vassil Panayotov, Guoguo Chen, Daniel Povey, and
  Sanjeev Khudanpur

The committed fixture names map to these source utterances:

| Fixture | Source utterance | Transformation |
|---|---|---|
| `en-clean-short.flac` | `2412-153948-0015` | none |
| `en-compressed.mp3` | `5694-64038-0014` | mono 16 kHz MP3 at 16 kbps |
| `en-noisy.flac` | `1272-141231-0027` | deterministic pink-noise mix, seed 424242 |
| `en-padded.flac` | `2412-153948-0015` | 1.25 s leading and 1.0 s trailing silence |
| `en-two-speaker.flac` | `2412-153948-0015`, `3000-15664-0023` | concatenated with a 0.75 s silence gap |
| `en-silence.flac` | generated | five seconds of mono 16 kHz digital silence |

## FLEURS

FLEURS is published by Google on Hugging Face under CC BY 4.0. Protocol 1 uses
three `dev` recordings from dataset revision `main` as retrieved on
2026-08-13. The original 16 kHz WAV bytes are retained.

- Dataset: https://huggingface.co/datasets/google/fleurs
- Paper: https://arxiv.org/abs/2205.12446

| Fixture | Configuration | Source recording |
|---|---|---|
| `vi-fleurs-ai.wav` | `vi_vn` | `10467396475561744099.wav` |
| `vi-fleurs-container.mp4` | `vi_vn` | `10467396475561744099.wav`, AAC audio muxed with a generated 320x180 H.264 dark frame track |
| `ko-fleurs-numeric.wav` | `ko_kr` | `12210668677626112210.wav` |
| `ja-fleurs-islands.wav` | `ja_jp` | `399340006455025662.wav` |

The MP4 derivative deliberately reuses the reviewed Vietnamese utterance. It
isolates container/video-upload compatibility from speech-content variance and
contains no personal or repository-local footage.

## AMI Meeting Corpus

The AMI Meeting Corpus signals and manual annotations are CC BY 4.0. The
fixture is a mono 16 kHz FLAC excerpt from `ES2004a.Mix-Headset.wav`, covering
81.8s through 102.2s. Its reference is derived from the AMI 1.6.2 manual word
annotations for speakers A and B.

- Corpus: https://groups.inf.ed.ac.uk/ami/corpus/
- Signal: `ES2004a.Mix-Headset.wav`
- Annotation release: `ami_public_manual_1.6.2.zip`

## Free Spoken Digit Dataset

Free Spoken Digit Dataset v1.0.8 is CC BY-SA 4.0. `en-fsdd-2026.flac` combines
the unmodified digit recordings `2_jackson_0.wav`, `0_nicolas_0.wav`,
`2_theo_0.wav`, and `6_jackson_0.wav` with deterministic 0.2s silence gaps.

- Repository: https://github.com/Jakobovski/free-spoken-digit-dataset/tree/v1.0.8
- DOI: https://doi.org/10.5281/zenodo.1342401

The source archive is not committed. Fixture SHA-256 values and durations are
part of `manifest.json`, and the normal test suite verifies every committed
byte before a live provider call is possible.

Speech envelopes and supplied-line timing references were measured from the
committed fixture bytes with FFmpeg `silencedetect` at `-35 dB` with a minimum
silence duration of 80 ms, then rounded to the nearest millisecond. They are
checked as toleranced timing references rather than treated as word-level
forced alignments.

Corpus-derived fixture files retain their source licenses: Mini LibriSpeech,
FLEURS, and AMI derivatives are CC BY 4.0; `en-fsdd-2026.flac` is an adapted
CC BY-SA 4.0 fixture. Benchmark code, manifests, and original translation cases
remain under the repository's MIT license.

The translation cases were written for this project and do not copy an
external benchmark corpus.

No fixture is sourced from the user's existing videos, subtitle files, editor
projects, or prior application imports. The benchmark runner only opens files
declared in `manifest.json` beneath this directory and verifies their hashes
before any network request.
