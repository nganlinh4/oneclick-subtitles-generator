// Enumerate what the real editor exposes, so journeys target ground truth.
//
// Not an assertion of product behaviour and deliberately not part of the default glob: it exists so
// a customer journey can be written against the controls the application really renders rather than
// against names guessed from source. Run it with `npm --prefix e2e run recon` when the UI moves.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { clickControl, openEditor } from '../support/editor.js';
import { FIXTURE_ROOT } from '../support/environment.js';

const survey = () => browser.execute(() => {
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const label = (node) => (
    node.getAttribute('aria-label')
    || node.getAttribute('title')
    || (node.innerText || '').trim().slice(0, 50)
    || node.getAttribute('placeholder')
    || ''
  );
  const describe = (node) => ({
    label: label(node),
    className: (node.getAttribute('class') || '').slice(0, 60),
    disabled: node.disabled === true,
  });

  const firstCueRow = document.querySelector('[class*="lyric-item" i], [class*="lyric-row" i], [class*="lyric" i]');
  return {
    buttons: [...document.querySelectorAll('button')].filter(visible).map(describe),
    inputs: [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')]
      .filter(visible).map(describe),
    // The structure of one cue row, which is what an edit has to drive.
    firstCueRow: firstCueRow === null ? null : {
      className: firstCueRow.getAttribute('class'),
      html: firstCueRow.outerHTML.slice(0, 900),
    },
  };
});

const show = (label, value) => console.log(`=== ${label} ===\n${JSON.stringify(value, null, 2)}`);

describe('the editor surface', () => {
  it('reports the controls reachable once a project has media and subtitles', async () => {
    await openEditor();
    await clickControl('[data-input-tab="file-upload"]');
    await clickControl('.file-upload-input');

    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelector('video') !== null)),
      { timeout: 120_000, interval: 1_000, timeoutMsg: 'media never activated' },
    );

    // cues-ascii.srt (not the retired media/cues-6s.srt fixture removed in 5c03e278) --
    // its first cue is this same "First cue for the preview" text.
    const subtitles = readFileSync(join(FIXTURE_ROOT, 'cues-ascii.srt'), 'utf8');
    await browser.execute((text, name) => {
      const target = document.querySelector('.srt-upload-button-container');
      const file = new File([text], name, { type: 'application/x-subrip' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      for (const type of ['dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }
    }, subtitles, 'cues-ascii.srt');

    await browser.waitUntil(
      async () => (await browser.execute(
        () => (document.body?.innerText || '').includes('First cue for the preview'),
      )),
      { timeout: 60_000, interval: 1_000, timeoutMsg: 'subtitles never appeared' },
    );
    await browser.pause(3_000);

    show('with media and subtitles', await survey());
  });
});
