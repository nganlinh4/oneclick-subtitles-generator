// A customer opens a local video, adds subtitles, and the editor draws them.
//
// This is a WORKFLOW journey, not a shell one: it is green only if the product did the job. It
// clicks the real "Upload File" tab and the real drop zone, and the application runs its actual
// `select_media` command, import, activation, identity and compositor code.
//
// The ONLY thing replaced is the operating system's file dialog, which a WebDriver session cannot
// drive. The application resolves the staged selection against a declared fixture root and hands it
// to exactly the same `import_media_path` a person's click produces, so nothing after the dialog is
// simulated. No IPC is mocked, no state is written behind the UI, no capability flag is fabricated.

import { strict as assert } from 'node:assert';

import {
  MEDIA_DURATION_SECONDS,
  importSubtitles,
  openProjectWithMedia,
  waitForNativeFrame,
} from '../support/workflow.js';

const inspect = () => browser.execute(() => {
  const text = (selector) => [...document.querySelectorAll(selector)]
    .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 6);
  const video = document.querySelector('video');
  return {
    errors: text('.error, [role="alert"]'),
    hasVideoElement: video !== null,
    videoDuration: Number.isFinite(video?.duration) ? video.duration : null,
    videoWidth: video?.videoWidth ?? null,
    videoHeight: video?.videoHeight ?? null,
    fontReadiness: window.__OSG_FONT_READINESS__?.state ?? null,
    previewUnavailable: text('.native-preview-unavailable'),
    hasNativeFrame: document.querySelector('.native-composited-frame') !== null,
  };
});

describe('a customer opens a local video', () => {
  it('activates it, takes subtitles, and draws a native subtitle frame', async () => {
    await openProjectWithMedia();

    let seen = await inspect();
    console.log(`after activation: ${JSON.stringify(seen, null, 2)}`);

    // It is the fixture, not something else that happens to play.
    assert.ok(
      Math.abs(seen.videoDuration - MEDIA_DURATION_SECONDS) < 0.5,
      `the activated media must be the ${MEDIA_DURATION_SECONDS} second fixture, `
        + `not ${seen.videoDuration}`,
    );
    assert.equal(seen.videoWidth, 640, 'the fixture is 640 wide');
    assert.equal(seen.videoHeight, 360, 'the fixture is 360 tall');
    // No assertion about the preview surface yet: the project has no subtitles at this point, and
    // what the product should say with nothing to draw is asserted by its own journey.

    await importSubtitles();

    // The point of the whole chain: the compositor draws the cue onto the source and the editor
    // shows that frame. Nothing in the WebView draws subtitles any more, so this element appearing
    // is the only evidence a preview really happened — a cue in the editing list proves the parse,
    // not the picture.
    await waitForNativeFrame();

    seen = await inspect();
    console.log(`after the first native frame: ${JSON.stringify(seen, null, 2)}`);
    assert.ok(seen.hasNativeFrame, 'a native composited frame must be on screen');
    assert.deepEqual(seen.previewUnavailable, [], 'the preview must not report itself unavailable');
    assert.deepEqual(seen.errors, [], 'no error may be visible once a frame has been drawn');
  });
});
