<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# PromptDJ MIDI

This workspace is the bundled, same-origin music interface used by the desktop
application. It contains no provider credentials or provider transport. The
Tauri host owns the authenticated live-music session and forwards bounded raw
PCM through the parent/iframe bridge.

## Development

1. Install dependencies from the repository root: `npm install`.
2. Run `npm run --workspace=promptdj-midi dev` for the standalone UI.
3. Run `npm run build:promptdj` to produce the assets embedded at `/promptdj/`.

The standalone browser build intentionally has no music-provider fallback. Live
generation is available only through the native parent transport.
