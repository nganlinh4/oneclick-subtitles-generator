# PromptDJ MIDI

The bundled music interface, served same-origin at `/promptdj/` inside the desktop app. It holds no
credentials and no provider transport: the Tauri host owns the Lyria session and forwards bounded
PCM through the parent/iframe bridge, so the standalone page cannot generate music.

- `npm run --workspace=promptdj-midi dev` serves the UI alone.
- `npm run build:promptdj` builds the assets the desktop frontend embeds.
- Fonts are bundled (Open Sans, `assets/fonts/fonts.manifest.json`) and recorded in
  `THIRD_PARTY_NOTICES.md`.
