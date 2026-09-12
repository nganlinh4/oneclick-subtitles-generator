# Gemini Interactions boundary

OSG uses the Gemini Interactions API as the sole request protocol for bounded,
turn-based model work. The shared `osg-gemini` crate owns request encoding,
response decoding, SSE events, retry classification, concurrency, cancellation,
credential headers, and output-size limits.

| Product work | Provider protocol | Reason |
| --- | --- | --- |
| Translation, grouping, language detection, prompts, and document work | Interactions | Text or structured model output |
| Audio/video understanding and ordinary Gemini subtitle generation | Interactions | Media input with text or structured output |
| Gemini 3.5 Transcribe | Interactions | Native transcription configuration and word annotations |
| Background image generation and editing | Interactions | Image response format and model-output image content |
| Large-media staging | Files API | Upload companion whose URI becomes Interaction input |
| Gemini Transcribe Live | Live API WebSocket | Continuous realtime session, not a turn-based Interaction |
| Gemini narration | Interactions | Audio response format with the dedicated TTS model |
| Gemini Live Music | Live Music WebSocket | Dedicated generative-music protocol |

The two WebSocket rows are independent provider protocols. They are not
fallbacks: a failed Interaction is never replayed through Live, and a failed
Live session is never replaced by ordinary transcription or generation.

## Product invariants

- Every Interaction sets `store: false`. OSG jobs are stateless and durable
  product state remains in the local project database.
- API keys remain behind the Rust credential boundary and are sent only in the
  `x-goog-api-key` header. Browser code cannot call provider origins.
- A streaming request may be retried only before an HTTP success response is
  accepted. Retrying after a delta could duplicate user-visible output.
- Structured output uses `response_format` with a bounded JSON schema. Feature
  services own their schemas; they do not own alternate Gemini transports.
- Native transcription consumes provider `word_info` annotations. Ordinary
  subtitle grouping remains a product concern downstream of those annotations.
- Uploaded provider URIs and resumable-session URLs never cross into frontend
  DTOs or durable project state.

The production-transport gate rejects retired `generateContent` and
`streamGenerateContent` URLs in native source, as well as direct Gemini access
from the WebView bundle.

Primary references:

- <https://ai.google.dev/gemini-api/docs/interactions-overview>
- <https://ai.google.dev/gemini-api/docs/migrate-to-interactions>
- <https://ai.google.dev/gemini-api/docs/streaming>
- <https://ai.google.dev/gemini-api/docs/transcribe>
- <https://ai.google.dev/gemini-api/docs/live-api/live-transcribe>
- <https://ai.google.dev/gemini-api/docs/files>
