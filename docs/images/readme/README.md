# README screenshots

Unretouched screenshots of OSG, captured in an off-screen native window with an isolated
profile. No personal projects, credentials or private media are used.

Footage: **NASA Explorers, Season 5, Episode 1: We Are the Artemis Generation**,
[NASA's Goddard Space Flight Center](https://svs.gsfc.nasa.gov/14205).
[Watch on YouTube](https://www.youtube.com/watch?v=2eFHWuNuDSA).
See [NASA's media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/).
This application is not affiliated with or endorsed by NASA.

OSG downloaded the video and its 196 supplied YouTube captions. These are not model-generated
subtitles or authored demonstration text. The selected interview frame was checked against
the raw download: it has no burned-in subtitles or name banner. The displayed caption,
“was about 30 to 35 different applications”, is OSG's overlay at 8:13.7095.

To capture again on the native branch:

```powershell
node scripts/build-e2e-binary.js
node e2e/run-isolated.mjs journeys/readmeScreenshots.journey.js
```

The journey uses the real URL download, editor and render-preview controls. It needs network
access, but no API key or cloud generation request. These screenshots document that workflow;
they are not evidence of transcription quality or coverage of every product feature.
Original captures and their manifest are retained in the managed local evidence cache.

Capture: 2026-09-18, native source commit `4b1b839a`, built-in UI scale 80%.
Application content hash: `62ad185c0e315e52d2388c78e962931c20063df5131731bae9237c75b40ed19c`.
Capture attempt: `20260918082645566-39628-561c97a2`.
