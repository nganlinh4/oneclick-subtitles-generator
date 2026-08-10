# Architecture

One-Click Subtitles Generator (OSG) is a local-first Tauri 2 desktop application. React remains
the presentation layer; Rust owns application state, filesystem access, provider credentials,
network adapters, durable work, external tools, and optional model workers.

This document describes the native rewrite. It is an implementation boundary, not a promise that
every optional runtime is already packaged. See [Runtime delivery](#runtime-delivery).

## Runtime topology

```text
React UI in the system WebView
  |  typed Tauri commands, bounded events, opaque IDs
  v
Tauri desktop host (apps/desktop/src-tauri)
  |-- application/domain services
  |-- SQLite projects, revisions, jobs, settings, and artifact metadata
  |-- operating-system credential store
  |-- Gemini, Lyria, Genius, and YouTube adapters
  |-- media/download/render orchestration
  `-- supervised ASR and speech workers over private stdin/stdout
```

The desktop app does not launch the former Electron, Express, Flask, FastAPI, CORS, WebSocket, or
fixed-port process mesh. Development uses Vite on port 3030 only while `tauri dev` is running.

Large local audio and video need byte-range responses for reliable seeking in system WebViews.
Rust starts one process-scoped capability streamer on `127.0.0.1` with an operating-system-assigned
port. It serves registered file handles plus bounded, native-fetched Genius/YouTube raster images
through opaque IDs and a random per-process token. React assigns those capabilities only to media
or image elements; script-level byte reads are prohibited. Waveform analysis and narration export
remain typed native operations, with native save UI keeping destination paths out of IPC. The
streamer is not a general application API. Details are in
[SECURITY.md](SECURITY.md#loopback-media-transport).

Separately, an active YouTube OAuth authorization opens a temporary callback listener on
`127.0.0.1` with an operating-system-assigned port. It accepts only the bounded OAuth redirect,
validates the exact host/path plus state and PKCE flow, and closes on success, cancellation, or its
three-minute deadline. It is not a persistent application service. See
[SECURITY.md](SECURITY.md#oauth-loopback-callback).

## Source boundaries

| Path | Responsibility |
| --- | --- |
| `src/`, `public/` | Canonical React UI, styles, assets, fonts, and locales. |
| `apps/desktop/src-tauri/` | Tauri composition root, platform adapters, command DTOs, capabilities, and release configuration. |
| `crates/osg-domain/` | Media, subtitle, project, revision, and job invariants; no UI or platform dependencies. |
| `crates/osg-application/` | Use cases and ports around the domain. |
| `crates/osg-infrastructure/` | SQLite storage, content-addressed artifacts, jobs, settings, and credential-vault integration. |
| `crates/osg-gemini/`, `crates/osg-live-music/`, `crates/osg-providers/` | Bounded native provider clients. |
| `crates/osg-media/`, `crates/osg-media-pipeline/`, `crates/osg-media-server/` | Typed FFmpeg/ffprobe plans, media transformations, and scoped playback transport. |
| `crates/osg-download/` | URL validation and managed yt-dlp downloads. |
| `crates/osg-render/`, `video-renderer/` | Durable render orchestration and the frozen Remotion composition/worker. |
| `crates/osg-asr/`, `crates/osg-speech/` | Typed local inference contracts and supervised worker protocols. |
| `crates/osg-engine-packages/`, `crates/osg-native-tools/` | Reviewed, content-addressed optional runtime delivery. |
| `promptdj-midi/` | Bundled PromptDJ/Lyria control surface, built into the desktop frontend. |

The canonical Gemini policy is `src/config/geminiModelCatalog.json`. Repository checks require
every selectable ordinary, image, or live model to accept at least audio or video; legacy IDs are
normalization aliases, not additional selectable/provider models.

Dependencies point inward: domain types do not import Tauri, the WebView, databases, provider
SDKs, or process adapters. Tauri commands translate path-free UI requests into native
capabilities and invoke the application layer.

## State and identity

- SQLite stores durable projects, immutable revisions, background-job state, settings, artifact
  metadata, and credential references.
- Native paths are retained inside Rust-owned state. The WebView normally receives UUID-backed
  project, asset, artifact, job, and credential identifiers instead of paths.
- Produced artifacts are staged, validated, hashed, and published without silently overwriting an
  existing destination.
- Long-running operations expose bounded progress and explicit cancellation. Durable jobs can be
  recovered after a WebView reconnect or application restart where the operation supports it.
- High-frequency playback and timeline work remains in the WebView; it does not round-trip through
  JSON IPC every frame.

## Native feature boundaries

The Tauri command surface currently covers:

- native file selection and drag-and-drop redemption;
- projects, immutable revisions and revision-navigation commands, jobs, settings, cache, and
  exports;
- Gemini transcription, translation, subtitle analysis, and image generation;
- Lyria RealTime music sessions, Genius lyrics, YouTube metadata, and YouTube OAuth;
- media probing, compatibility transforms, audio extraction, waveform generation, and downloads;
- durable Remotion render jobs and playback handles;
- local ASR, narration, reference-audio, audio-edit, voice-conversion, and alignment contracts;
- managed native-tool and engine/package lifecycles, plus the signing-key-gated update-metadata
  check.

An implemented command or worker contract does not make its external executable, model, or
installer available. Optional runtimes fail closed until a reviewed release exists for the target.
The lyrics editor keeps an immediate in-memory interaction stack for responsive controls and
serializes the same logical edits into a separate, bounded SQLite track-history cursor. That cursor
survives restart and applies only the selected canonical subtitle track to the latest project
snapshot, so undo can cross newer media or other-track revisions without reverting them. Text edits
are grouped after 500 ms of inactivity and flushed before navigation or save. Both the 256-state
native cursor and its 255-edge local mirror are bounded; the serialized native queue is limited by
operation count and retained bytes, and any failure blocks save until authoritative reconciliation.

## Runtime delivery

Runtime catalogs are the only authority for downloaded executables and model packages. Entries
must use immutable upstream sources, exact sizes and hashes, safe relative paths, and applicable
license notices. Installations use staging plus verified publication and retain receipts for later
status/removal checks.

At the current rewrite checkpoint:

- ASR releases are withheld for all targets.
- Speech/TTS releases are withheld for all targets.
- Remotion's Node/Chromium/renderer/native-binary/font/notice runtime releases are withheld for
  all targets.
- Windows x64 downloads the exact reviewed FFmpeg/ffprobe `8.1.2` vendor archive on demand. Linux
  and macOS remain withheld pending equivalent reviewed delivery.
- Reviewed yt-dlp `2026.07.04` and Deno `2.9.5` releases are catalogued for content-addressed,
  direct-upstream, on-demand delivery; they are never bundled in the application. A user-initiated
  URL inspection performs the status check, requests explicit batch consent, and exposes bounded
  progress plus cancellation through the existing toast surface. No startup task downloads tools.
- A genuine yt-dlp process failure starts one coalesced, throttled official-release check. Only a
  stable release marked immutable is eligible; GitHub's asset digest and notices from the exact tag
  commit become the new receipt. The new version is published beside the leased version and becomes
  active only after restart. Invalid input, cancellation, timeout, and generic network failures do
  not trigger this path, and the failed media operation is never automatically retried. The native
  host caches checks for 30 minutes, retains two verified rollback generations, and quarantines
  damaged generations before repair.
- The updater's check-only command is structurally wired but remains disabled until the owner
  supplies a real signing public key and securely manages the corresponding private key. Update
  installation is not part of the current command surface.

The speech hold also covers complete transitive wheel/native-library inventories, notices,
offline/per-target validation, and provider-terms review. In particular, the reviewed F5TTS v1
base weights are `CC-BY-NC-4.0`; a general commercial-capable default needs a different reviewed
model or an explicit owner-approved product policy and acceptance flow. The frozen custom-model UI
does not override this boundary: arbitrary model URLs and edits are intentionally not installable
until a reviewed content-addressed package contract exists.

The native-tool ACL contains only `native_tools_catalog`, `native_tools_status`,
`native_tool_install`, and `native_tool_cancel`. Public catalog/status DTOs
do not contain executable paths or upstream URLs. Live consumers hold native leases, so activation
or a deferred removal may correctly require an application restart. Download runtimes snapshot
their executable paths during Tauri startup; therefore the preflight treats a completed install as
restart-required and never claims immediate activation. The existing media flow reaches
catalog/status/install/cancel. Native removal remains an internal manager lifecycle used for
verified cleanup and tests; it is not exposed to the WebView. Download start offers the Windows
media-tool package when it is missing and fails closed on targets whose catalog remains empty.

Consequently, source compilation can pass while a distributable runtime package correctly fails
the stricter release-readiness gate.

The release-policy portion of that gate also remains blocked until the owner selects the root
project license, approves the third-party-notice/corresponding-source disclosure policy, and adds
`THIRD_PARTY_NOTICES.md`. PromptDJ uses the operating-system UI font stack and packages no separate
font payload.

## Visual compatibility

The rewrite deliberately reuses the original JSX, CSS, fonts, assets, locales, workflow order, and
Remotion composition. Native capability adapters sit behind existing interactions. Repository
gates compare the frontend, PromptDJ, and render surfaces with baselines derived from the original
source so an architectural change cannot silently become a redesign.

See [docs/rewrite/DESIGN.md](docs/rewrite/DESIGN.md) for the visual-freeze policy.

## Legacy import

Migration is explicit and user-selected. The importer reads a bounded `localStorage.json` plus
known legacy artifact directories, rejects links/reparse points and source changes, and records a
content fingerprint so retries are idempotent.

The visual-freeze policy leaves the original settings surface unchanged. In the desktop app, press
`Ctrl+Alt+Shift+I` on Windows/Linux or `Command+Option+Shift+I` on macOS to open the native legacy
data-folder picker. Browser-only builds do not install this action. Selection/import status and the
path-free result are reported through the existing toast panel; imported settings take effect after
restart.

Safe preferences move to SQLite, supported credentials move to the operating-system credential
store, and supported artifacts are copied into native content-addressed storage. Transient state,
paths, URLs, provider file handles, stale caches, and unsupported secrets are ignored. The source
directory is retained; import is not a destructive conversion.

## Platform targets

The workspace and CI matrix target Windows x64 (`x86_64-pc-windows-msvc`), Linux x64
(`x86_64-unknown-linux-gnu`), macOS Intel (`x86_64-apple-darwin`), and macOS Apple Silicon
(`aarch64-apple-darwin`). Windows is the currently exercised development host. The macOS and Linux
targets have build-matrix configuration but still require real-device runtime, media, packaging,
signing, and installer testing before they should be described as supported releases.
