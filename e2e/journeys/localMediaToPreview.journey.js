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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { clickControl, openEditor } from '../support/editor.js';
import { FIXTURE_ROOT } from '../support/environment.js';

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
    hasNativeFrame: document.querySelector('.native-composited-frame') !== null,
    // Whether the imported cue text is anywhere a customer can read it. Searching the rendered
    // text rather than a class name, because the class that holds a cue is an implementation
    // detail and the first version of this check matched an empty-state help message instead.
    showsFirstCue: (document.body?.innerText || '').includes('First cue for the preview'),
  };
});

const report = (label, seen) => console.log(`--- ${label} ---
${JSON.stringify(seen, null, 2)}`);

describe('a customer opens a local video', () => {
  it('activates it, takes subtitles, and draws a native subtitle frame', async () => {
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
    // No assertion about the preview surface yet: the project has no subtitles at this point, and
    // what the product should say with nothing to draw is asserted after they are imported.

    // --- subtitles ------------------------------------------------------------------------------
    //
    // The SRT control opens an ordinary file input rather than a native dialog, so the file is
    // handed to the element the customer's chooser would have filled. Everything after that -- the
    // parse, the cue model, the project revision and the native preview -- is the product's own.
    // Dropped onto the real control, which is one of the two ways a customer supplies subtitles.
    // The chooser's own input is hidden behind a button, and WebDriver cannot fill an element it
    // cannot see; the drop handler is the same component reading the same file with the same reader,
    // so nothing about the import is bypassed. The bytes are the fixture's own.
    const subtitles = readFileSync(join(FIXTURE_ROOT, 'cues-6s.srt'), 'utf8');
    const dropped = await browser.execute((text, name) => {
      const target = document.querySelector('.srt-upload-button-container');
      if (target === null) return 'no drop target';
      const file = new File([text], name, { type: 'application/x-subrip' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      for (const type of ['dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }));
      }
      return 'dropped';
    }, subtitles, 'cues-6s.srt');
    console.log(`subtitle drop: ${dropped}`);
    assert.equal(dropped, 'dropped', 'the SRT drop target must exist');

    await browser.pause(4_000);
    const afterDrop = await browser.execute(() => ({
      srtButtonClass: document.querySelector('.srt-upload-button')?.getAttribute('class') ?? null,
      hasUploadedMarker: document.querySelector('.has-srt-uploaded') !== null,
      lyricRows: document.querySelectorAll('[class*="lyric" i]').length,
      // Where the editor keeps what it has, so a drop that parsed but did not reach the editor is
      // distinguishable from one that never parsed.
      storageKeys: Object.keys(window.localStorage).filter((key) => /subtitle|lyric|srt/i.test(key)),
      bodyMentionsCue: (document.body?.innerText || '').includes('First cue'),
      alerts: [...document.querySelectorAll('[role="alert"], .error')]
        .map((node) => (node.innerText || '').trim()).slice(0, 4),
    }));
    console.log(`after the drop: ${JSON.stringify(afterDrop, null, 2)}`);

    await browser.waitUntil(async () => {
      seen = await inspect();
      return seen.showsFirstCue;
    }, {
      timeout: 60_000,
      interval: 1_000,
      timeoutMsg: () => 'the imported subtitles never appeared in the editor. last: '
        + JSON.stringify(seen, null, 2),
    });

    report('after importing subtitles', seen);

    // --- the native subtitle frame --------------------------------------------------------------
    //
    // The point of the whole chain: the compositor draws the cue onto the source and the editor
    // shows that frame. Nothing in the WebView draws subtitles any more, so this element appearing
    // is the only evidence a preview really happened.
    await browser.waitUntil(async () => {
      seen = await inspect();
      return seen.hasNativeFrame;
    }, {
      timeout: 90_000,
      interval: 1_000,
      timeoutMsg: () => 'no native composited frame was ever published. last: '
        + JSON.stringify(seen, null, 2),
    });

    report('after the first native frame', seen);
    assert.deepEqual(seen.previewUnavailable, [], 'the preview must not report itself unavailable');
    assert.deepEqual(seen.errors, [], 'no error may be visible once a frame has been drawn');
  });
});
