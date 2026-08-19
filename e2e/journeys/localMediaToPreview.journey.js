// A customer opens a local video and the editor shows it.
//
// This is a WORKFLOW journey, not a shell one: it is green only if the product did the job. It
// clicks the real "Upload File" tab and the real drop zone, and the application runs its actual
// `select_media` command, its actual import, activation, identity and artifact code.
//
// The ONLY thing replaced is the operating system's file dialog, which a WebDriver session cannot
// drive. The application resolves the staged selection against a declared fixture root and hands it
// to exactly the same `import_media_path` a person's click produces, so nothing after the dialog is
// simulated. No IPC is mocked, no state is written behind the UI, no capability flag is fabricated.

import { strict as assert } from 'node:assert';

import { clickControl, openEditor } from '../support/editor.js';

const ACTIVATION_TIMEOUT_MS = 120_000;
const EXPECTED_DURATION_SECONDS = 6;

const inspect = () => browser.execute(() => {
  const text = (selector) => [...document.querySelectorAll(selector)]
    .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 6);
  const video = document.querySelector('video');
  return {
    errors: text('.error, [role="alert"]'),
    status: text('[role="status"]'),
    hasVideoElement: video !== null,
    videoReadyState: video?.readyState ?? null,
    videoDuration: Number.isFinite(video?.duration) ? video.duration : null,
    videoWidth: video?.videoWidth ?? null,
    videoHeight: video?.videoHeight ?? null,
    fontReadiness: window.__OSG_FONT_READINESS__?.state ?? null,
    previewUnavailable: text('.native-preview-unavailable'),
  };
});

describe('a customer opens a local video', () => {
  it('activates it and shows it in the editor', async () => {
    await openEditor();

    // The real tab, then the real drop zone. Clicking it is what asks native for a file.
    await clickControl('[data-input-tab="file-upload"]');
    await clickControl('.file-upload-input');

    let seen = await inspect();
    await browser.waitUntil(async () => {
      seen = await inspect();
      return seen.hasVideoElement && seen.videoDuration !== null;
    }, {
      timeout: ACTIVATION_TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: () => 'the selected media never became playable in the editor. last observation: '
        + JSON.stringify(seen, null, 2),
    });

    console.log('after activation:\n' + JSON.stringify(seen, null, 2));

    // It is the fixture, not something else that happens to play.
    assert.ok(
      Math.abs(seen.videoDuration - EXPECTED_DURATION_SECONDS) < 0.5,
      `the activated media must be the ${EXPECTED_DURATION_SECONDS} second fixture, `
        + `not ${seen.videoDuration}`,
    );
    assert.equal(seen.videoWidth, 640, 'the fixture is 640 wide');
    assert.equal(seen.videoHeight, 360, 'the fixture is 360 tall');
    assert.deepEqual(seen.errors, [], 'no error may be visible after a successful activation');
  });
});
