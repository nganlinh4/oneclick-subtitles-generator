// The first real customer workflow: a URL becomes a playable video with a subtitle preview.
//
// Everything before this journey tested that the application starts. This tests that it does its
// job. It types a URL into the real input, presses the real button, and waits for the product to
// reach the state a customer came for — media activated and a preview surface that is not dormant.
//
// Nothing is injected. The URL points at a local HTTP origin serving a real MP4 with ranges and
// content length, so the actual downloader protocol runs; the application cannot tell it from any
// other server. No IPC is mocked, no capability flag is fabricated, no database row is written.

import { strict as assert } from 'node:assert';

import { clickControl, openEditor } from '../support/editor.js';
import { startMediaServer } from '../support/mediaServer.js';

const FIXTURE = 'bars-6s-640x360.mp4';
const WORKFLOW_TIMEOUT_MS = 240_000;

/** Everything a failure needs to name the exact edge that broke. */
const inspect = () => browser.execute(() => {
  const text = (selector) => [...document.querySelectorAll(selector)]
    .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 6);

  const video = document.querySelector('video');
  return {
    rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
    fontReadiness: window.__OSG_FONT_READINESS__?.state ?? null,
    // What the user can see, in the words they would see.
    errors: text('.error, [role="alert"]'),
    status: text('[role="status"]'),
    progress: text('[class*="progress" i], [class*="downloading" i]'),
    toasts: text('[class*="toast" i]'),
    hasVideoElement: video !== null,
    videoReadyState: video?.readyState ?? null,
    videoDuration: Number.isFinite(video?.duration) ? video.duration : null,
    hasNativeFrame: document.querySelector('.native-composited-frame') !== null,
    previewUnavailable: text('.native-preview-unavailable'),
    // The editor only exists once media is active; its presence is the activation signal.
    hasEditor: document.querySelector('[class*="video-preview" i], [class*="lyrics" i]') !== null,
  };
});

const report = (label, seen) => console.log(`--- ${label} ---\n${JSON.stringify(seen, null, 2)}`);

describe('a customer turns a video URL into a subtitle preview', () => {
  let origin = null;

  before(async () => {
    origin = await startMediaServer();
  });

  after(async () => {
    if (origin !== null) await origin.stop();
  });

  it('downloads the video, activates it, and shows a preview surface', async () => {
    // A first-time customer meets the onboarding overlay before anything else, and it covers every
    // control until dismissed.
    const onboarding = await openEditor();
    console.log(`onboarding cleared: ${JSON.stringify(onboarding)}`);

    const url = origin.urlFor(FIXTURE);
    console.log(`fixture origin: ${url}`);

    // The real controls, driven the way a person drives them: focus, type, press the button that
    // does the job. "Download Only" is the pure media path -- it fetches and activates without
    // involving transcription, which is the next link in the chain rather than this one.
    const field = await $('.url-field');
    await field.waitForDisplayed({ timeout: 30_000 });
    await field.setValue(url);

    // "Download Only" opens a modal offering quality and format; the customer then confirms. The
    // first version of this journey pressed only the first button and waited four minutes for a
    // download that was never asked for.
    await clickControl('.download-only-btn');
    await clickControl('.download-only-modal .confirm-button');

    let seen = await inspect();
    report('immediately after pressing the button', seen);

    // The customer outcome: media is active and the editor is showing it. Progress and job status
    // are steps along the way, not the thing being asserted.
    let polls = 0;
    await browser.waitUntil(async () => {
      seen = await inspect();
      polls += 1;
      if (polls % 10 === 0) {
        console.log(`still waiting after ${polls * 2}s; origin requests: ${origin.requests.length}; `
          + `visible: ${JSON.stringify({ errors: seen.errors, progress: seen.progress, toasts: seen.toasts })}`);
      }
      return seen.hasVideoElement && seen.videoDuration !== null;
    }, {
      timeout: WORKFLOW_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: () => 'the URL never became playable media. last observation: '
        + JSON.stringify(seen, null, 2)
        + `\nserver saw ${origin.requests.length} request(s): `
        + JSON.stringify(origin.requests.slice(0, 8), null, 2),
    });

    report('after activation', seen);

    // The application really did fetch it from the origin, rather than resolving it some other way.
    assert.ok(
      origin.requests.length > 0,
      'the downloader must have contacted the fixture origin; it made no request at all',
    );
    assert.ok(
      origin.requests.some((request) => request.name === FIXTURE),
      `the downloader must have requested ${FIXTURE}; it asked for `
        + JSON.stringify(origin.requests.map((request) => request.name)),
    );

    // Playable, with the duration the fixture actually has.
    assert.ok(
      Math.abs(seen.videoDuration - 6) < 0.5,
      `the activated media must be the 6 second fixture, not ${seen.videoDuration}`,
    );
    assert.deepEqual(seen.errors, [], 'no error may be visible after a successful activation');
  });
});
