# OSG — One-Click Subtitles Generator

[Tiếng Việt](README.vi.md)

A Windows desktop workspace for generating, editing and translating subtitles, adding narration,
and exporting subtitled video.

## Get OSG

**[Download OSG 1.0.0 for Windows x64](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/v1.0.0/OSG-1.0.0-windows-x64-setup.exe).**
Windows may show an unsigned-publisher warning. Native updates use a separate signed channel.
OSG 1.0.0 is the current release. Native application source is on `rewrite/tauri-rust`;
`main` temporarily retains the legacy application code for existing batch-file users.

[OSG 1.0.0 release](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/tag/v1.0.0) ·
[Release checklist](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/docs/release/WINDOWS-1.0-VALIDATION.md)

The 1.0.0 release targets **Windows x64**, using Tauri, WebView2 and Rust.
The packaged application does not need Node.js or a development server.
Native video export requires a compatible Direct3D GPU and driver; software-only Windows VMs
do not provide the required video-device path.
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
See [migration instructions](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/docs/DEVELOPMENT.md#data-and-migration).

### Legacy edition

Need the old application? Use the [v2.6.1 release](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/tag/v2.6.1)
and its [Windows batch installer](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/v2.6.1/OSG_installer_Windows.bat).
Do not use the generic Latest link for the legacy installer; Latest now means native OSG.

## Development

Install the pinned toolchains and system prerequisites in the [development guide](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/docs/DEVELOPMENT.md), then:

```powershell
git fetch origin
git switch rewrite/tauri-rust
npm ci
npm --prefix apps/desktop ci
npm run tauri:dev
```

Use the managed launch command: opening the debug executable alone does not start Vite.
Builds and evidence use a [bounded external cache](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/docs/rewrite/DEVELOPMENT_CACHE.md).
The approved Material 3 Expressive UI on the current branch is the visual baseline—not legacy main.

[Architecture](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/ARCHITECTURE.md) · [Security](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/SECURITY.md) ·
[Visual policy](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/docs/rewrite/DESIGN.md) ·
[Report an issue](https://github.com/nganlinh4/oneclick-subtitles-generator/issues)

## License

OSG source is [MIT licensed](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/LICENSE). Dependencies, downloadable models, runtimes and fonts
retain their own terms; see [third-party notices](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/THIRD_PARTY_NOTICES.md).
