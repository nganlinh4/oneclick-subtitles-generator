# OSG — One-Click Subtitles Generator

[Tiếng Việt](README.vi.md)

A Windows desktop workspace for generating, editing and translating subtitles, adding narration,
and exporting subtitled video.

## Get OSG

**OSG 1.0.0 is being prepared for release.** `rewrite/tauri-rust` is the canonical application
branch. The existing GitHub v2.6.1 release is the legacy application, not this native version.

[Releases](https://github.com/nganlinh4/oneclick-subtitles-generator/releases) ·
[Release checklist](docs/release/WINDOWS-1.0-VALIDATION.md)

The 1.0.0 release targets **Windows x64**, using Tauri, WebView2 and Rust.
The packaged application does not need Node.js or a development server.
Linux and macOS are not supported releases.

## Features

- Open local media or download supported online videos.
- Generate subtitles with Gemini or optional local speech-recognition engines.
- Edit text, timing and speakers; translate and save subtitle files.
- Customize subtitles and export video with the native renderer.
- Generate narration with downloadable speech engines.
- Supporting tools for video analysis, documents, images and music.

Gemini features require your own API keys and internet access. Availability, quotas and charges
depend on your provider account. Local engines download separately and may require several GB
of disk space; hardware requirements vary. Required runtime tools install on demand.

## Data and migration

Projects and settings are stored locally; API credentials use the operating-system credential store.
Cloud features send the media or text required for the operation to the selected provider.
Local-first does not mean every feature runs offline.

Legacy 2.x → native 1.0.0 is a **manual migration**, not an automatic downgrade.
Keep your old data until the import is verified.
See [migration instructions](docs/DEVELOPMENT.md#data-and-migration).

## Development

Install the pinned toolchains and system prerequisites in the [development guide](docs/DEVELOPMENT.md), then:

```powershell
npm ci
npm --prefix apps/desktop ci
npm run tauri:dev
```

Use the managed launch command: opening the debug executable alone does not start Vite.
Builds and evidence use a [bounded external cache](docs/rewrite/DEVELOPMENT_CACHE.md).
The approved Material 3 Expressive UI on the current branch is the visual baseline—not legacy main.

[Architecture](ARCHITECTURE.md) · [Security](SECURITY.md) ·
[Visual policy](docs/rewrite/DESIGN.md) ·
[Report an issue](https://github.com/nganlinh4/oneclick-subtitles-generator/issues)

## License

OSG source is [MIT licensed](LICENSE). Dependencies, downloadable models, runtimes and fonts
retain their own terms; see [third-party notices](THIRD_PARTY_NOTICES.md).
