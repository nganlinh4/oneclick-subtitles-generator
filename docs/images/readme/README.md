# README screenshots

These are unretouched screenshots of the native OSG application, captured through its embedded
automation channel in an off-screen window with an isolated profile. No personal projects,
credentials or private media are used.

The video is **Sintel**, © Blender Foundation, [www.sintel.org](https://www.sintel.org/),
licensed under [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
See the [film's licensing information](https://durian.blender.org/about/).
The trailer is obtained from [W3C's public media archive](https://media.w3.org/2010/05/sintel/trailer.mp4).
The captions are authored demonstration text added in OSG, not dialogue from the film and not
a claim about model transcription quality. The film frames are shown within the application UI.

To capture again, use the native branch's opt-in `e2e/journeys/readmeScreenshots.journey.js`:

```powershell
node scripts/build-e2e-binary.js
node e2e/run-isolated.mjs journeys/readmeScreenshots.journey.js
```

The capture uses ordinary media import, subtitle import and editor controls. It makes no cloud
generation requests. Its screenshots are documentation assets, not proof of all product workflows.
Full-resolution originals and the capture manifest are retained in the managed local evidence cache.

Capture: 2026-09-18, native source commit `18664c0b`, built-in UI scale 80%.
Application SHA-256: `a693399474a67bce4a2bba5f5adffea2f42309490302e8343a86cc3ea3a27f53`.
Capture attempt: `20260918080337520-65076-e978ce4a`.
