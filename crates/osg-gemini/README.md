# osg-gemini

Backend-only Gemini media transport for the Tauri rewrite. The API key, local
path, raw bytes, upload-session URL, and provider file URI are never serializable
frontend DTOs.

## Frozen model policy (verified 2026-08-10)

The OSG-owned allowlist is reviewed against the official stable, daily-use REST
endpoints and applies the strict rule that every exposed model must accept audio
or video. Each retained
model officially supports **both** audio and video input and text output:

| API model | Toolbox role | Official evidence |
| --- | --- | --- |
| `gemini-3.5-flash-lite` | default/fast vision, direct audio translation, high-volume extraction | <https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite> |
| `gemini-3.6-flash` | strongest current multimodal analysis | <https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash> |
| `gemini-3.5-flash` | stable strong fallback | <https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash> |
| `gemini-3.1-flash-lite` | stable low-cost compatibility fallback | <https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite> |

Intentionally excluded: text/image-only or output-generation models, embedding
models, robotics previews, Live API previews, deprecated/shut-down endpoints,
and presentation aliases such as `google-...-vision`. The crate accepts only the
provider API IDs above, avoiding alias drift.

## Wire and resilience policy

- `v1beta ...:generateContent` with `x-goog-api-key` header auth; keys never
  appear in URLs.
- Maximum 20,000,000-byte serialized inline request and 15,000,000 bytes per
  inline media blob. The final serialized size includes Base64 expansion,
  prompts, instructions, and schema.
- Files API uploads default to the free-tier-safe 2 GB ceiling, use resumable
  sessions and bounded chunks, verify server offsets after ambiguous failures,
  and poll `PROCESSING` to `ACTIVE` with a deadline.
- At most ten media inputs, matching current Gemini 2.5+ video guidance.
- Bounded response/error bodies, bounded concurrency, per-model 429 cooldown,
  `Retry-After`/`google.rpc.RetryInfo` support, jittered exponential backoff for
  `408`, `429`, transport failures, and `5xx` only.
- Every network wait, retry delay, semaphore wait, and processing poll observes
  a `CancellationToken`.
- Current Gemini 3 sampling fields deprecated by Google (`temperature`, `top_p`,
  `top_k`) are absent from the typed request API.

Primary protocol references:

- Generate Content: <https://ai.google.dev/api/generate-content>
- Files API: <https://ai.google.dev/gemini-api/docs/files>
- Audio input: <https://ai.google.dev/gemini-api/docs/audio>
- Video input: <https://ai.google.dev/gemini-api/docs/video-understanding>
- Retry guidance: <https://ai.google.dev/gemini-api/docs/troubleshooting>
- Rate limits: <https://ai.google.dev/gemini-api/docs/rate-limits>

## Manual live media smoke

`examples/live_media_smoke.rs` sends one bounded WAV and MP4 request to every
allowed model and prints only the model ID, modality, and a sanitized result
class. It never prints the key, prompt, provider body, or media path.

Set `GEMINI_API_KEY`, `OSG_GEMINI_SMOKE_AUDIO`, and
`OSG_GEMINI_SMOKE_VIDEO`, then run:

```text
cargo run -p osg-gemini --example live_media_smoke --locked
```

For a quota-safe retry, set `OSG_GEMINI_SMOKE_MODEL` to one exact allowlisted
ID and optionally set `OSG_GEMINI_SMOKE_MODALITY` to `audio` or `video`.

For local OSG development, the ignored repository-root `.env` may provide the
live-test credential pool as `GEMINI_API_KEY`, `GEMINI_API_KEY_2`, through
`GEMINI_API_KEY_20`. Test tooling may select a non-empty value in-process, but
must never print values, copy them into logs/artifacts, commit `.env`, or make
the shipped application read `.env`. Prefer `gemini-3.5-flash-lite` and one
bounded modality for routine live verification; use additional keys only for
explicit quota/failure testing through the native credential boundary.
