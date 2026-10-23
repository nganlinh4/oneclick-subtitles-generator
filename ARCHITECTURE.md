# Architecture

OSG is a local-first Tauri 2 desktop app. React (`src/`) is the presentation layer; Rust owns state,
files, credentials, provider traffic, media work, rendering and worker supervision. Windows x64 is
the shipped target.

```text
React UI in the system WebView
  |  typed Tauri commands, bounded events, opaque IDs
  v
Tauri host (apps/desktop/src-tauri)
  |-- application and domain services, SQLite (projects, revisions, jobs, settings, artifacts)
  |-- OS credential store
  |-- Gemini, Lyria, Genius and YouTube clients
  |-- media, download, render and export orchestration
  |-- loopback media streamer (byte ranges for <video>/<img> only)
  `-- supervised ASR and speech workers over private stdin/stdout
```

There is no Electron, Express, Python web server, fixed port or CORS layer. Vite runs on port 3030
only during `tauri dev`.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/`, `public/` | The React UI, styles, fonts and locales. The visual source of truth. |
| `promptdj-midi/` | PromptDJ/Lyria surface, built into the frontend and embedded at `/promptdj/`. |
| `apps/desktop/src-tauri/` | Tauri composition root: commands, DTOs, capabilities, platform adapters, release config. |
| `crates/osg-domain`, `osg-application` | Domain invariants and use cases; no UI, platform or I/O dependencies. |
| `crates/osg-infrastructure` | SQLite storage, content-addressed artifacts, jobs, settings, credential vault. |
| `crates/osg-gemini`, `osg-live-music`, `osg-providers` | Bounded provider clients. |
| `crates/osg-media`, `osg-media-pipeline`, `osg-media-server` | FFmpeg/ffprobe plans, media transforms, the loopback streamer. |
| `crates/osg-download` | URL validation and the managed yt-dlp adapter. |
| `crates/osg-render`, `osg-scene`, `osg-compositor`, `osg-decode`, `osg-encode`, `osg-audio`, `osg-gpu-video`, `osg-export` | The native renderer; see [docs/rewrite/NATIVE_RENDERER.md](docs/rewrite/NATIVE_RENDERER.md). |
| `crates/osg-asr`, `osg-speech` | Local ASR and speech contracts and their supervised workers. |
| `crates/osg-engine-packages`, `osg-native-tools`, `osg-delivery-core` | Reviewed, content-addressed delivery of optional runtimes, models and tools. |
| `crates/osg-process`, `osg-runtime-staging`, `osg-formats` | Child-process supervision, crash-safe staging, bounded binary-format parsing. |

Dependencies point inward: domain crates never import Tauri, the WebView, databases, provider SDKs
or process adapters.

## State and identity

- SQLite holds projects, immutable revisions, jobs, settings, artifact metadata and credential
  references. Native paths stay in Rust; the WebView gets UUID-backed IDs.
- Outputs are staged, verified, hashed and published without overwriting an existing file.
- Long operations report bounded progress and support cancellation; durable jobs survive a reload
  or restart where the operation allows it.
- Playback and timeline interaction stay in the WebView; nothing round-trips IPC per frame.
- Editor undo has an in-memory stack for immediate controls plus a bounded SQLite history cursor
  per subtitle track that survives restart.

## Providers

Gemini work goes through one Rust transport on the Interactions API (`store: false`, key in the
`x-goog-api-key` header). The Files API stages large media; Live transcription, Live TTS and Live
Music use their own WebSocket protocols and are never fallbacks for each other. Structured output
uses fixed-size schemas, and every response is validated locally (ordinals, counts, non-blank
text) before it is stored. `src/config/geminiModelCatalog.json` is the model policy: every
selectable model must accept audio or video.

## Optional runtimes

Tools (yt-dlp, Deno, FFmpeg/ffprobe on Windows), ASR and speech engines, voice samples and the UI
font come only from the reviewed catalogs in `crates/*/delivery/`: immutable upstream URLs first,
the append-only `osg-runtime-bundles-v1` pool second, exact sizes and hashes, full inventories and
notices. Nothing falls back to `PATH`, pip, npm or an unverified file. Installs are staged, verified,
published atomically and leased while in use; removal of a busy tool reports busy instead of
needing a restart. Required tools install on first use with progress and cancel in the existing
toast. A failing yt-dlp triggers one throttled check for a newer immutable official release.

The desktop executable itself carries no executables, interpreters or models; the payload budget
(`scripts/check-desktop-payload-size.mjs`) enforces that.

## Platforms

CI builds Windows x64, Linux x64 and macOS (Intel and Apple Silicon). Only Windows has complete
delivery catalogs and passes the `runtime-package` readiness profile; the other targets compile
but are not released.
