# OSG subtitle benchmark

This opt-in benchmark compares every stable Gemini media model shipped by OSG
on work the product actually performs. It uses the production `osg-gemini`
upload and streaming transports, a versioned manifest, exact fixture hashes,
round-major scheduling, stable credential rotation, and append-only attempt
records. The three prompt shapes and response schemas mirror the application's
ordinary transcription, provided-line timing, and single-language translation
paths; benchmark-only retry or prompt repair is forbidden.

The benchmark is deliberately split into three score families:

1. **Transcription** — word/character accuracy, silence hallucination,
   timestamp envelope accuracy, valid ordering, overlap, and subtitle
   readability.
2. **Provided-line timing** — exact index/text coverage, boundary mean absolute
   error, and interval overlap for the app's "time my subtitles" flow.
3. **Subtitle translation** — exact line/original pairing, protected token
   preservation, automatic chrF similarity, and a human-review rubric. The
   automatic translation score is an aid, not a final quality judgment.

Latency, upload time, time to first output, generation time, real-time factor,
token usage, provider model version, and failure class are reported separately.
A failed provider call remains a failed benchmark cell; the runner adds no
retry beyond the production transport's bounded retry policy.

The live benchmark intentionally measures the provider transport directly.
The desktop app separately short-circuits only built-in speech tasks when a
native full-stream check proves that audio is absent or exactly digital zero;
custom prompts, visual descriptions, OCR, chaptering, supplied-line timing,
and any uncertain or nonzero audio continue to the selected model normally.

## Safety and reproducibility

- The normal Rust test validates the manifest, catalog, fixtures, hashes, and
  scoring code without network access.
- Live calls require both an ignored test and `SUBTITLE_BENCH_LIVE=1`.
- `.env` credential discovery accepts only `GEMINI_API_KEY` and canonical
  numeric slots `_2` through `_20`. Process environment values override file
  values, blanks and duplicates are ignored, and secret values are never
  serialized or printed.
- Results go under `target/subtitle-benchmark/runs/` by default and are not
  committed automatically.
- The manifest, exact fixture bytes, scorer source, and production-transport
  benchmark runner source form the protocol fingerprint. Any prompt, schema,
  scoring, model-set, runtime request, or fixture change invalidates resume;
  intentional metric changes also require a scoring-version bump.

## Run

```powershell
$env:SUBTITLE_BENCH_LIVE = '1'
cargo test -p osg-gemini --test subtitle_benchmark subtitle_benchmark_live -- --ignored --nocapture
```

Useful optional controls:

```powershell
$env:SUBTITLE_BENCH_SUITES = 'transcription,timing,translation'
$env:SUBTITLE_BENCH_MODELS = 'gemini-3.1-flash-lite,gemini-3.6-flash'
$env:SUBTITLE_BENCH_MIN_START_GAP_MS = '1000'
$env:SUBTITLE_BENCH_OUTPUT = 'target/subtitle-benchmark/runs/my-run'
$env:SUBTITLE_BENCH_RESUME = 'target/subtitle-benchmark/runs/my-run'
```

Each run writes `attempts.jsonl`, `run.json`, `summary.json`, `summary.md`, and
`translation-review.md`. Resume skips only already-successful cells with the
same protocol and fixture fingerprint. Scheduling is by difficulty round, with
the first model rotated each round, so one model cannot consume every easy case
or always run first.

## Interpreting results

Use reliability and strict-pass rate as gates. Compare accuracy and timing
within each suite, then inspect latency/token efficiency. Do not publish a
single combined winner, and do not promote translation rankings without human
review against the recorded rubric. Silence, lossy audio, noise, rare words,
proper nouns, multi-speaker segmentation, and real timestamp gaps are retained
as separate cohorts so regressions stay diagnosable.

The user's existing ignored `videos/` and `subtitles/` directories are never
used by this benchmark. Protocol fixtures come only from the reviewed public
sources documented in `SOURCES.md`: Mini LibriSpeech, FLEURS, AMI, and FSDD,
plus deterministic derivatives for codec, noise, silence, timing, and MP4
container coverage.
