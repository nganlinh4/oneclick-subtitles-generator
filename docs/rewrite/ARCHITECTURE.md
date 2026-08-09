# Rewrite architecture

## Product boundary

One-Click Subtitles Generator is a local-first application for turning media into accurate,
editable, export-ready subtitles. The desktop base must start without Node, Python, model
runtimes, fixed ports, or background services. Optional engines are installed and launched only
when a user selects them.

The rewrite preserves user artifacts and workflow semantics. It does not preserve legacy module
boundaries, HTTP endpoints, component APIs, caches, globals, timers, or process topology.

## Non-negotiable invariants

- Rust will own canonical project, media, subtitle, job, and settings state as each backend slice
  migrates.
- The existing WebView remains visually unchanged; legacy browser persistence is removed only when
  an equivalent Rust-owned compatibility adapter is ready.
- Every long-running operation is bounded, cancellable, observable, and recoverable.
- High-frequency playback and timeline data never traverse JSON IPC on every frame.
- Media is referenced by an opaque application identity, not a browser blob URL.
- Credentials never enter WebView storage and are never written to plaintext project files.
- Local files are selected through dedicated commands; the frontend receives no general
  filesystem or shell capability.
- Formats are parsed and written by tested Rust code with millisecond precision.
- Large optional engines are separately versioned, hashed, and downloaded on demand.

## Workspace boundaries

```text
apps/desktop
  Tauri host, commands, capabilities, and platform adapters

repository-root src/ and public/
  canonical existing OSG frontend, reused without visual changes

crates/osg-domain
  project, media, subtitle, revision, and job invariants
  subtitle format parsers and writers
  no Tauri, UI, database, network, or process dependencies

crates/osg-application
  use cases and ports around the domain
  session orchestration and local-file inspection
  no Tauri or WebView dependencies

future adapters
  SQLite repositories
  FFmpeg/ffprobe and yt-dlp processes
  Gemini clients
  optional supervised inference workers
```

Dependencies point inward. Platform adapters can depend on application and domain crates; the
domain never imports a platform adapter.

## Runtime topology

```text
System WebView
    │ small typed commands, events, and coarse snapshots
    ▼
Tauri bridge
    ▼
Rust application core
    ├── SQLite project/revision store
    ├── bounded job scheduler
    ├── media and waveform cache
    ├── Gemini adapter
    ├── FFmpeg render plan
    └── optional supervised engine workers
```

There is no internal Express server, CORS layer, WebSocket progress server, fixed port registry,
or UI-driven process orchestration. If a research model still requires Python, one Rust-owned
worker is started lazily with an explicit ready handshake and a private structured protocol.

## Performance model

- A single playback clock owns the playhead.
- Sorted subtitle tracks use indexed lookup instead of repeated linear searches.
- The playhead is painted outside React's component tree.
- Cue layout and overlap indexes rebuild only when a track revision changes.
- FFmpeg produces bounded multi-resolution waveform peaks once per content hash.
- The UI requests only the visible timeline range.
- Rendering consumes local paths and a render plan; it never explodes a video into PNG frames.
- Job concurrency is explicit and conservative. Cancellation retains and terminates the exact
  child process rather than searching the machine by port or process name.

## Compatibility boundary

The migration layer will read:

- SRT with UTF-8, multiline text, and millisecond timestamps.
- Legacy subtitle JSON arrays with `start`, `end`, and `text`, plus tolerated legacy fields.
- Existing loose subtitle caches for one-time import.
- Explicitly allowed preferences, prompts, rules, language, model choices, and render presets.

New storage will use stable UUIDs and SQLite migrations. Legacy cache identifiers remain lookup
aliases only. Parser bugs, duplicated timing fields, transient browser flags, plaintext secrets,
and stale index coupling are not compatibility requirements.

## Migration sequence

1. Secure Tauri shell hosting the existing OSG frontend, plus canonical subtitle/media domain.
2. Compatibility bridge for local media plus SRT/JSON import, editing, durable save/reopen, and
   export behind existing UI interactions.
3. FFprobe metadata, seekable playback, indexed timeline, and cached waveform peaks.
4. Gemini transcription through the same cue and job model.
5. Translation and download adapters.
6. Native FFmpeg rendering and narration adapters.
7. Optional local inference engine packages.
8. One-time legacy migration, parity verification, and deletion of Electron/Node runtime code.

The existing frontend remains canonical while slices are incomplete. New Rust adapters replace
its localhost and Electron dependencies from behind the existing interaction contract; they do not
replace or restyle the interface.
