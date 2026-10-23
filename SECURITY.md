# Security model

OSG treats the WebView, imported files, URLs, provider responses, downloaded archives and worker
output as untrusted. Rust owns every privileged operation and exposes only purpose-specific
commands. This describes the design; it is not an independent audit.

To report a vulnerability, open a GitHub issue that asks for a private contact, without exploit
details.

## Privilege boundary

- Tauri global injection is off. The `main` capability lists each custom permission, and
  `npm run check:tauri-contract` rejects drift between handlers, permissions and capabilities.
- No shell, process launcher, generic filesystem access or URL opener is exposed to the WebView.
- File access starts with a native picker or a one-time drag-and-drop offer; later requests use
  opaque IDs. Exports pick their destination natively.
- Production `connect-src` allows only the app and Tauri IPC. Provider traffic originates in Rust.
- Every WebView font ships with the app as a hash-pinned file, so the WebView makes no request to
  Google or any other origin.

## Credentials and private content

- API keys, OAuth clients and refresh tokens live in Windows Credential Manager (macOS Keychain or
  Secret Service elsewhere). SQLite stores references only. Secrets can be written through IPC but
  never read back.
- Gemini keys go in a header, never a URL. Prompts, provider file handles, native paths, media
  bytes and upload-session URLs stay out of status/error DTOs and logs.
- A locked or missing credential store makes credential features fail closed; the app still starts.

## Files and packages

- UI-visible errors are path-free.
- Imports and managed packages reject traversal, absolute paths, links and reparse points,
  duplicates, unexpected types, oversize entries and hash mismatches.
- A package's status check trusts a per-install receipt (sizes of every inventoried file) after one
  full verification. A same-size edit after that is caught only by the next full verification;
  read-only, no-clobber publication is the primary defense.
- Outputs use private staging and verified no-clobber publication.

## Network

- Download URLs reject credentials, non-default ports, loopback, private and link-local targets,
  and mixed public/private DNS answers before yt-dlp starts. yt-dlp's own secondary requests are not
  sandboxed; enforce egress at the OS or network layer if you need that.
- Provider bodies, retries, concurrency, timeouts, uploads, redirects and responses are bounded, and
  cancellation reaches child processes.
- Genius artwork and YouTube thumbnails are fetched natively, signature-checked as JPEG, PNG, WebP or
  GIF, and served to the WebView only as loopback capabilities.

## Updater

- `app_update_check`, `app_update_install` and `app_update_cancel` sit behind the
  `check-for-updates` capability and run only on user action or the one startup check.
- The feed is fixed: `osg-desktop-updater-v2.json` on the `app-update-feed` branch, read over HTTPS
  from `raw.githubusercontent.com` (`apps/desktop/src-tauri/tauri.conf.json`).
- Packages are verified against the committed minisign key
  (`apps/desktop/src-tauri/updater-public-key.txt`) before install. An install is bound to the
  version the check returned, only one runs at a time, and it can be cancelled while downloading.
- Signed releases v1.0.0, v1.0.1 and v1.0.2 have shipped; v1.0.2 is GitHub Latest. The signing key
  exists only as Actions secrets.
- There is no rollback. NSIS passive mode (`/P /R`) uninstalls then installs, so a half-applied
  update is fixed by reinstalling.
- The installer is not Authenticode-signed.

## Loopback media transport

For `<video>`/`<img>` playback Rust binds a private byte-range server to `127.0.0.1` on an
OS-assigned port. It serves only handles and image bytes registered by native code, under opaque
IDs and a random per-process token; checks the WebView origin and MIME type; bounds assets, bytes,
headers, queue depth, workers and socket deadlines; and implements only the HTTP subset that range
requests need. CSP allows it in `media-src` and `img-src` only, not `connect-src`, and the
production transport gate rejects reachable raw `fetch`/XHR call sites. Waveforms, narration export
and rendering are typed native operations, not reads through this server.

## OAuth loopback callback

Only while YouTube OAuth is in progress, Rust listens on a second OS-assigned `127.0.0.1` port. It
accepts loopback peers on the exact `/oauth2callback` path, verifies state and PKCE, caps headers at
8 KiB and attempts at eight, uses five-second socket deadlines, and expires after three minutes.

## Workers

ASR and speech run as private child processes: fixed programs from reviewed packages, closed typed
arguments, no shell, an allowlisted environment, and framed stdin/stdout. Cancellation, timeout,
malformed output or a protocol error kills the owned process tree. Nothing searches `PATH` for a
missing runtime; an empty catalog makes the feature unavailable.

## Supply chain

- Node, npm, Python, Rust and Tauri versions and both lockfiles are pinned and checked.
- GitHub Actions are pinned to reviewed SHAs, the token is read-only, checkouts do not persist
  credentials, and signing secrets reach only the two manual signed jobs.
- `node scripts/check-release-readiness.js --profile runtime-package` refuses missing tools, empty
  catalogs, unmanaged loopback endpoints and an unconfigured updater key.

## Open notice items

`LICENSE` (MIT) and `THIRD_PARTY_NOTICES.md` ship in the installer. Still open:

- There is no in-app attribution screen; the packaged files are the only notices.
- FFmpeg (GPL-3.0-or-later) is downloaded from Gyan's builds, not re-hosted. This project does
  re-host the LGPL-3.0-only Edge TTS runtime, the ASR runtime (CUDA redistributables, CPython,
  MPL-2.0 certifi) and the Google Sans Flex font on `osg-runtime-bundles-v1`, without a written
  source offer. Whether one is required is the owner's call.
- The published notice index `windows-managed-runtime-notices.json` lists 17 components; the
  speech catalog also fetches `charactr/vocos-mel-24khz` (MIT). Fixing it means publishing a new
  content-addressed notice asset and recomposing every engine manifest that embeds it; see
  `THIRD_PARTY_NOTICES.md`.

## Changes that need review

Tauri capabilities, command DTOs, provider endpoints, URL policy, credential handling, artifact
roots, worker launch rules, delivery catalogs, updater keys, CSP and the loopback transport need
focused tests and review. Never get past a failing readiness gate by weakening it or adding an
unverified artifact.
