# One-Click Subtitles Generator

Xem bản tiếng Việt [tại đây](README.vi.md).

## Screenshots

<details>
<summary>Click to view screenshots</summary>

Here are some screenshots showcasing the application's current features:

<div align="center">
  <table>
    <tr>
      <td><img src="readme_assets/0.png" width="100%"></td>
      <td><img src="readme_assets/1.png" width="100%"></td>
      <td><img src="readme_assets/2.png" width="100%"></td>
    </tr>
    <tr>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
    </tr>
    <tr>
      <td><img src="readme_assets/3.png" width="100%"></td>
      <td><img src="readme_assets/4.png" width="100%"></td>
      <td><img src="readme_assets/5.png" width="100%"></td>
    </tr>
    <tr>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
    </tr>
    <tr>
      <td><img src="readme_assets/6.png" width="100%"></td>
      <td><img src="readme_assets/7.png" width="100%"></td>
      <td><img src="readme_assets/8.png" width="100%"></td>
    </tr>
    <tr>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
    </tr>
    <tr>
      <td><img src="readme_assets/9.png" width="100%"></td>
      <td><img src="readme_assets/10.png" width="100%"></td>
      <td><img src="readme_assets/11.png" width="100%"></td>
    </tr>
    <tr>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
    </tr>
    <tr>
      <td><img src="readme_assets/12.png" width="100%"></td>
      <td><img src="readme_assets/13.png" width="100%"></td>
      <td><img src="readme_assets/14.png" width="100%"></td>
    </tr>
    <tr>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
    </tr>
    <tr>
      <td><img src="readme_assets/15.png" width="100%"></td>
      <td><img src="readme_assets/16.png" width="100%"></td>
      <td><img src="readme_assets/17.png" width="100%"></td>
    </tr>
    <tr>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
    </tr>
    <tr>
      <td><img src="readme_assets/18.png" width="100%"></td>
      <td><img src="readme_assets/19.png" width="100%"></td>
      <td><img src="readme_assets/20.png" width="100%"></td>
    </tr>
    <tr>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
    </tr>
    <tr>
      <td><img src="readme_assets/21.png" width="100%"></td>
      <td><img src="readme_assets/23.png" width="100%"></td>
      <td><img src="readme_assets/24.png" width="100%"></td>
    </tr>
    <tr>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
    </tr>
    <tr>
      <td><img src="readme_assets/25.png" width="100%"></td>
      <td><img src="readme_assets/26.png" width="100%"></td>
      <td><img src="readme_assets/27.png" width="100%"></td>
    </tr>
    <tr>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
    </tr>
    <tr>
      <td><img src="readme_assets/28.png" width="100%"></td>
      <td><img src="readme_assets/29.png" width="100%"></td>
      <td><img src="readme_assets/30.png" width="100%"></td>
    </tr>
    <tr>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
    </tr>
    <tr>
      <td><img src="readme_assets/31.png" width="100%"></td>
      <td><img src="readme_assets/32.png" width="100%"></td>
      <td><img src="readme_assets/33.png" width="100%"></td>
    </tr>
    <tr>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
    </tr>
    <tr>
      <td><img src="readme_assets/34.png" width="100%"></td>
      <td><img src="readme_assets/35.png" width="100%"></td>
      <td><img src="readme_assets/36.png" width="100%"></td>
    </tr>
    <tr>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
    </tr>
    <tr>
      <td><img src="readme_assets/37.png" width="100%"></td>
      <td><img src="readme_assets/38.png" width="100%"></td>
      <td></td>
    </tr>
    <tr>
      <td align="center"><strong>Caption later</strong></td>
      <td align="center"><strong>Caption later</strong></td>
      <td></td>
    </tr>
  </table>
</div>

</details>

OSG is a local-first desktop workspace for transcribing media, editing and translating subtitles,
creating narration and supporting media, and rendering subtitled video. The current rewrite keeps
the existing interface intact while replacing the Electron and multi-server backend with Tauri 2
and a Rust application core.

> **Rewrite checkpoint:** the source application compiles and its native feature contracts are in
> place, but there is no release-ready installer yet. Several optional runtime catalogs are
> intentionally empty, and macOS/Linux still need real-device testing. Do not use the deleted
> legacy installer scripts or expect a hosted/Vercel edition.

## What is native now

| Area | Current state |
| --- | --- |
| Projects and editing | Native media selection/drop, SQLite projects and immutable revisions, durable jobs, settings, cache, subtitle import, and native export. Existing undo/redo controls mirror a bounded, restart-durable track cursor that preserves newer media and unrelated project state. |
| Gemini | Rust-owned transcription, translation, subtitle analysis, image generation, key rotation/cooldown, and bounded uploads. Every ordinary exposed model accepts audio or video. |
| Providers and music | Native Genius, YouTube metadata/OAuth, provider-image proxying, and Lyria RealTime sessions; secrets stay in the operating-system credential store. |
| Media and downloads | Typed probe, compatibility, extraction, waveform, download, and cancellation pipelines. Packaged execution still depends on reviewed target tools. |
| Local ASR | Supervised Parakeet, Faster-Whisper, and Qwen3-ASR contracts are implemented; release packages are not yet available. |
| Narration | F5-TTS, Chatterbox, Edge TTS, gTTS, Gemini Live, reference audio, voice conversion, editing, and alignment contracts are implemented; release packages are not yet available. |
| Rendering | Durable native Remotion worker orchestration is implemented; the target-specific Node/Chromium/Remotion/native-binary/font/notice payload is not yet available. |
| Updating | The native update-metadata check fails closed until the owner supplies the production signing public key; update installation is not exposed yet. |

The native command surface is not the same as runtime availability. Missing tools and models are
reported as unavailable; OSG does not silently download unreviewed binaries or fall back to the old
localhost services.

### Gemini model policy

`src/config/geminiModelCatalog.json` is the single frontend model catalog and records
`screen-goated-toolbox/catalog/model_catalog.json` as its synchronization source. It exposes
`gemini-3.5-flash-lite` (the everyday/transcription default), `gemini-3.6-flash`,
`gemini-3.5-flash`, and `gemini-3.1-flash-lite` for ordinary multimodal work; all four accept audio
and video. Image generation uses `gemini-3.1-flash-image`, which accepts video, while live audio
uses `gemini-3.1-flash-live-preview` and `gemini-2.5-flash-native-audio-preview-12-2025`.
`npm run test:gemini-catalog` rejects any exposed model that accepts neither audio nor video and
keeps obsolete IDs as migration aliases rather than selectable models.

## Platform status

| Target | Status |
| --- | --- |
| Windows x64 | Current development and manual test host; source builds are exercised, but release packaging is still gated. |
| macOS Apple Silicon / Intel | Build-matrix targets exist; runtime, media, signing, and installer behavior have not yet been manually validated. |
| Linux x64 | A build-matrix target exists; runtime, media, desktop integration, and package behavior have not yet been manually validated. |

The intended product is cross-platform, but macOS and Linux are not yet supported release claims.

## Run from source

Required toolchains are pinned to Node.js 24.19.0, npm 11.17.0, Python 3.12.10,
Rust 1.97.1, and Tauri CLI 2.11.4.
Install the
[Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system,
then run from the repository root:

```powershell
npm ci
npm --prefix apps/desktop ci
npm run tauri:dev
```

Tauri starts Vite automatically. `npm run dev:vite` is available for frontend-only inspection, but
browser mode cannot exercise native commands and is not a functional replacement for the desktop
app.

To compile without creating an installer:

```powershell
npm run build:frontend
cargo check --workspace --all-features --locked
npm run tauri -- build --no-bundle --ci -- --locked
```

## Verification

The main local gates are:

```powershell
npm audit --omit=dev --audit-level=high
npm run check:dependencies
npm run lint
npm test
npm run check:i18n
npm run test:gemini-catalog
npm run test:frontend-env
npm run test:python-workers
npm run test:frozen-css
npm run test:production-transport
npm run check:versions
npm run test:version-consistency
npm run check:tauri-contract
npm run check:visual-freeze
npm run test:visual-contract
npm run test:render-worker
npm run build:frontend
npm run check:frozen-css-output
npm run check:production-transport
node scripts/check-release-readiness.js --profile compile
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
```

`compile` verifies source/repository invariants. The stricter target-specific `runtime-package`
profile is expected to fail until the withheld runtimes, updater key, and owner-approved
license/notice policy are supplied; bypassing it does not make a valid release.

For example, the Windows release gate is:

```powershell
node scripts/check-release-readiness.js --profile runtime-package --target x86_64-pc-windows-msvc
```

The other matrix targets are `x86_64-unknown-linux-gnu`, `aarch64-apple-darwin`, and
`x86_64-apple-darwin`.

## Runtime delivery status

| Runtime | Delivery status |
| --- | --- |
| yt-dlp | Reviewed `2026.07.04` content-addressed direct-upstream releases are catalogued for the four target families. The first user-initiated URL inspection that needs it asks for consent, reports cancellable install progress, and requires restart before activation; it is never bundled or downloaded at startup. |
| Deno | Reviewed `2.9.5` content-addressed direct-upstream releases are catalogued for the four target families. The same consented URL-inspection preflight installs it with cancellable progress and stops for restart before activation; it is never bundled or downloaded at startup. |
| FFmpeg / ffprobe | Withheld pending provenance-complete GPL-capable builds, corresponding source, and notices for every target. |
| Parakeet / Faster-Whisper / Qwen3-ASR | No reviewed package releases are published in the catalog. |
| F5-TTS / Chatterbox / Edge TTS / gTTS / Gemini TTS worker | No reviewed package releases are published in the catalog. |
| Remotion runtime | No reviewed Node/Chromium/Remotion/native-binary/font/notice payload releases are published in the catalog. |
| Application updater | Public key is unconfigured; the check-only command returns unavailable without fetching. Installing an update is not exposed by the current command surface. |

The visually frozen YouTube settings help still describes the retired Web-application callback.
For the native flow, create a Google OAuth **Desktop app** client; Rust opens a temporary
`127.0.0.1` loopback callback with an operating-system-assigned port. Ignore the displayed origin
and `/oauth2callback.html` instructions: that browser callback is deliberately absent from the
production bundle. Correcting the visible help text requires separate visual/content approval.

The frozen API-key helper copy also still says keys are stored in the browser. In native mode,
legacy browser values are imported once and scrubbed; active secrets live only in the operating
system credential store. Correcting that visible sentence likewise requires separate content
approval.

Speech delivery additionally needs complete transitive-wheel/native-library inventories, notices,
offline and per-platform validation, and provider-terms review. The reviewed F5TTS v1 base model is
`CC-BY-NC-4.0`, so it cannot become a general commercial-capable default without a different model
or an explicit owner-approved product policy and acceptance flow. The preserved custom-model UI
is not a native arbitrary-URL installer: only reviewed content-addressed speech packages may become
launchable, so custom URL/edit operations remain unavailable until that policy and implementation
exist.

PromptDJ currently preserves the frozen interface with bundled Product Sans files. Those files do
not have an approved redistribution basis, so the release-policy gate rejects them until the owner
licenses them or separately approves a visually reviewed replacement and records every bundled
font in `THIRD_PARTY_NOTICES.md`.

The `manage-native-tools` capability exposes only the typed catalog/status/install/remove/cancel
commands; executable paths and upstream URLs stay native. OSG reports when activation or a deferred
removal must wait for restart because a live consumer holds a tool lease. The current user flow
reaches catalog, status, install, and cancel from an existing media action; it does not expose tool
removal. A single consent prompt identifies the exact yt-dlp/Deno packages and licenses before any
download. Installation progress uses the existing toast surface with an explicit cancel action,
and a successful install never retries the media action in the stale runtime: it asks the user to
restart first. FFmpeg/ffprobe remain unavailable and are never offered through this preflight.

Development builds may discover explicitly approved source-tree or system tools in debug mode.
Release builds do not rely on `PATH` or arbitrary local installations.

## Data and migration

The native app stores projects, revisions, job state, settings, and artifact metadata in SQLite.
Credentials live in Windows Credential Manager, macOS Keychain, or Linux Secret Service; the UI
receives opaque references and safe status only.

Legacy import is an explicit, user-selected operation. It can copy bounded supported artifacts,
safe preferences, and supported credentials from an old data folder. It rejects links and changed
sources, is safe to retry, leaves the source directory untouched, and ignores transient caches,
paths, URLs, and obsolete provider handles.

In the desktop app, press `Ctrl+Alt+Shift+I` on Windows/Linux or `Command+Option+Shift+I` on macOS,
then choose the previous OSG data folder in the native picker. The app reports a path-free summary
through its existing toast panel. Restart OSG afterward to load imported settings.

## Visual freeze

The rewrite preserves the original JSX, CSS, assets, fonts, themes, locales, responsive behavior,
workflow order, PromptDJ surface, and Remotion composition. Native work is connected behind those
interactions. Any intentional product-design change needs separate approval and a separately
reviewed baseline update.

The maintained locale sets are English, Vietnamese, and Korean. `npm run check:i18n` requires every
statically referenced translation key to be covered by Vietnamese and Korean and rejects reviewed
user-facing strings that bypass i18n.

## Documentation

- [Architecture and crate boundaries](ARCHITECTURE.md)
- [Security and trust model](SECURITY.md)
- [Visual-freeze policy](docs/rewrite/DESIGN.md)
- [Desktop host notes](apps/desktop/README.md)
- [Native render worker](video-renderer/README.md)

## License

A root project license has not been selected. The repository owner must choose and add `LICENSE`
and approve the project-level third-party-notice/corresponding-source policy; the release gate also
requires `THIRD_PARTY_NOTICES.md`. Licenses declared by dependencies or individual crates do not
establish a license for the repository as a whole.
