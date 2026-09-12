# Gemini translation structured output

Research and provider verification date: 2026-09-12.

## Authoritative references

- [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- [Prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies)
- [Migrating to the Interactions API](https://ai.google.dev/gemini-api/docs/migrate-to-interactions)
- [Streaming interactions](https://ai.google.dev/gemini-api/docs/streaming)
- [Gemini API troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting)

Google documents structured output as syntactic conformance, not semantic correctness. OSG must
therefore continue to validate every ordinal, row count, target-language count, non-blank string,
and caller-owned project boundary after generation. Schema-valid output is not sufficient.

## OSG wire contract

Translation uses a constant-size, row-major envelope:

```json
{
  "schemaVersion": 2,
  "rows": [
    { "ordinal": 0, "translations": ["…"] }
  ]
}
```

The target-language order and source rows are captured by the caller. The provider does not echo
language labels, source IDs, source text, or timing. Echoing caller data consumes output tokens but
cannot prove that the associated translation is semantically aligned. OSG rebinds validated
positions to its own immutable source IDs and timing.

The schema uses supported JSON Schema fields only: `type`, `properties`, `required`,
`additionalProperties`, `items`, `minItems`, `minimum`, `maximum`, and descriptions. It never grows
per-cue enums or per-request cardinality bounds. In a live Gemini 3.5 Flash Lite probe, the former
dynamic schema succeeded with 64 source-ID enum values but returned HTTP 400 at 72, 96, and 116.
The constant schema accepted the real 116-cue request and returned all 116 rows in exact order.

## Prompt hierarchy

Behavioral constraints belong in `systemInstruction`. Subtitle strings are supplied once in the
user prompt as explicitly untrusted JSON data. This follows Google's guidance to prioritize
critical rules in the system instruction and separate instructions from input data. Custom style
instructions may affect wording but cannot relax identity, completeness, or output-shape rules.

## Streaming and persistence

Google documents structured-output stream chunks as concatenable partial JSON. OSG incrementally
scans only the top-level `rows` array and publishes a row after that complete object passes local
shape, ordinal, language-count, and non-blank checks. This path is advisory UI state only. It cannot
persist data or acknowledge a provider delivery; the complete response must still pass the strict
terminal parser first.

## Interactions migration boundary

Google now recommends the Interactions API for new work, while `generateContent` remains supported
as the legacy API. OSG must not migrate translation as an isolated frontend exception. The eventual
migration belongs in `osg-gemini` so credentials, cancellation, retries, cooldowns, bounded SSE
parsing, usage accounting, recovery keys, durable delivery, and redacted diagnostics retain one
implementation. Contract v2 is API-neutral: it maps directly from `responseJsonSchema` to the new
top-level `response_format` schema without changing translation persistence or UI semantics.
