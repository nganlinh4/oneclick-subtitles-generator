# Security model

OSG treats the WebView, imported files, public URLs, provider responses, downloaded archives, and
model-worker output as untrusted. Rust owns privileged operations and exposes only purpose-specific
commands to the primary desktop window.

This is an architecture description, not an independent security audit.

## Privilege boundary

- Tauri global injection is disabled. Frontend code uses the module API.
- The `main` capability explicitly lists each custom permission; command generation and repository
  checks reject drift between handlers, permissions, and capabilities.
- There is no general shell command, arbitrary process launcher, filesystem read/write permission,
  or generic URL opener exposed to the WebView.
- File and folder access begins with a native picker or a one-time drag-and-drop offer. Native
  code validates and retains the path; later UI requests use opaque identifiers.
- Production `connect-src` permits only the application and Tauri IPC endpoints. Provider network
  requests originate in Rust rather than browser JavaScript.

## Credentials and private content

- API keys, OAuth clients, and refresh tokens are stored in Windows Credential Manager, macOS
  Keychain, or Linux Secret Service. SQLite contains typed metadata and opaque references, not the
  values.
- A secret can be submitted to a command but cannot be read back through IPC. Provider adapters
  resolve it inside Rust and redact secret-bearing debug/error values.
- Gemini keys use an HTTP header, never a URL. Prompts cross IPC only through purpose-specific,
  bounded request/event contracts and are redacted from debug output. Provider file handles,
  native paths, raw media, and upload-session URLs are excluded from status/error DTOs and
  ordinary diagnostics.
- If the platform credential store is locked or unavailable, credential-dependent operations fail
  closed; the desktop can still start.

## Files, artifacts, and exports

- Asset and artifact IDs cross IPC instead of native paths. UI-visible errors are intentionally
  path-safe.
- Imports and managed packages reject traversal, absolute paths, links/reparse points, duplicate
  entries, unexpected file types, size overruns, and content/hash mismatches.
- Generated artifacts use private staging and verified no-clobber publication. Exports use a native
  destination picker and do not accept a caller-supplied output path.
- Legacy import is bounded, idempotent, source-preserving, and detects a source replaced during the
  scan. Location-bearing and transient browser values are not migrated.

## Network policy

- Gemini, Lyria, Genius, YouTube, yt-dlp inspection, package delivery, and update traffic are owned
  by bounded native adapters.
- Genius artwork and YouTube thumbnails are fetched by native allowlisted clients, raster
  MIME/signature checked, and exposed only as process-scoped loopback capabilities. Provider image
  origins are not permitted by the production WebView CSP.
- Public download URLs reject credentials, non-default ports, loopback, private, link-local, and
  mixed public/private DNS answers before launching yt-dlp. External extractors may make secondary
  requests; deployments needing a hard egress sandbox must also enforce it at the operating-system
  or network layer.
- Provider bodies, retry counts, concurrency, timeouts, upload sizes, redirects, and response sizes
  are bounded. Cancellation propagates through waits and managed child processes.
- The frozen visual shell still loads its existing Google Fonts styles and glyphs through the
  narrow `style-src`/`font-src` CSP entries. This is the remaining deliberate WebView HTTPS egress;
  replacing it with reviewed local font files would change the visual asset contract and requires
  separate visual approval. Provider/API traffic is not permitted through those directives.
- The check-only updater command uses a fixed HTTPS `latest.json` endpoint and is gated by strict
  minisign-compatible public-key format validation. Checks remain unavailable while
  `apps/desktop/src-tauri/updater-public-key.txt` contains the placeholder value; update
  installation is not exposed by the current command surface.

## Loopback media transport

OSG has no separately launched Express, Flask, FastAPI, WebSocket, CORS, or fixed-port localhost
application service. For system-WebView playback and native-fetched provider images, Rust binds a
private byte-range capability streamer to `127.0.0.1` on an operating-system-assigned port.

That transport:

- serves only file handles and bounded raster bytes registered by native code;
- uses opaque asset IDs and a random per-process token;
- validates the WebView origin and media MIME type;
- accepts only exact JPEG, PNG, WebP, and GIF signatures for in-memory images;
- bounds registered assets, image bytes/count/lifetime, headers, queue depth, workers, and socket
  deadlines;
- supports only the small HTTP subset needed for media range requests; and
- is allowed by production CSP under `media-src` and `img-src`, not `connect-src`.

Capability URLs are element-source capabilities only. WebView script does not fetch their bytes:
the production CSP denies those connections, the browser transport adapter rejects exact native
capabilities and all other loopback fetch inputs before issuing a request, and the production
transport gate rejects reachable raw `fetch`/XHR call sites. Waveform generation, narration export
(including ZIP creation), rendering, and other byte-consuming work use typed native operations
keyed by opaque IDs.

The streamer carries media/image bytes only and is not a replacement backend API.

## OAuth loopback callback

Only while the user is completing YouTube OAuth, Rust binds a second, temporary listener to
`127.0.0.1` on an operating-system-assigned port. It accepts loopback peers only, requires the
exact callback host and `/oauth2callback` path, verifies the random state and PKCE exchange, limits
headers to 8 KiB and callback attempts to eight, applies five-second socket I/O deadlines, and
expires the entire authorization after three minutes. Cancellation closes the flow. The listener
returns only a minimal success/failure page to the system browser and is not reachable through a
general WebView command or persistent HTTP API.

## Optional workers

ASR, speech, and rendering may require Python or Node-based runtimes, but Rust supervises them as
private child processes. Programs and bootstrap paths come from approved native configuration,
arguments are closed and typed, shells are not involved, environments are allowlisted, and IPC uses
bounded framed messages over stdin/stdout. Cancellation, timeout, malformed output, or protocol
failure terminates the owned process tree.

Release builds do not search arbitrary `PATH` entries or improvise missing runtimes. Empty delivery
catalogs deliberately make the related feature unavailable.

## Supply chain and release posture

- JavaScript and Rust dependency graphs are locked; Node, npm, Rust, Tauri, and Remotion versions
  are pinned and checked.
- Managed runtime catalogs require immutable source URLs, exact digests and sizes, inventories,
  and notices. Extraction and installation are content-addressed and fail closed; native-tool
  catalog/status DTOs expose neither executable paths nor upstream URLs.
- The CI GitHub token has read-only repository contents permission, and checkout does not persist
  Git credentials. Manual packaging validation is separately gated from ordinary source
  compilation; production signing credentials are not configured by this repository.
- The strict runtime-package gate rejects missing tools, empty engine/render catalogs, unmanaged
  loopback endpoints, missing native capabilities, and an unconfigured updater key.

The repository still needs an owner-selected root license and an approved third-party-notice and
corresponding-source disclosure policy; the release gate requires `THIRD_PARTY_NOTICES.md`. No
project-wide license should be inferred from individual dependencies or crate metadata.

## Security-sensitive changes

Changes to Tauri capabilities, command DTOs, provider endpoints, URL policy, credential handling,
artifact roots, worker launch rules, delivery catalogs, updater keys, CSP, or the loopback media
transport require focused tests and review. Do not bypass a failing readiness gate by weakening the
gate or adding an unverified runtime artifact.
