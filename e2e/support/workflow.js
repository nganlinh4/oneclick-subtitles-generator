import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { clickControl, openEditor } from './editor.js';
import { FIXTURE_ROOT } from './environment.js';

/**
 * The steps every project-level journey has to perform before it can test anything of its own.
 *
 * Shared rather than repeated so a journey reads as the thing it is checking, and so a change to
 * how media or subtitles arrive is made once. Every step here drives the real interface: nothing
 * writes project state, and the only substitution is the operating system's file chooser, which a
 * WebDriver session cannot operate.
 */

export const MEDIA_FIXTURE = 'bars-6s-640x360.mp4';
/** Plain text, for journeys whose subject is not glyph coverage. */
export const SUBTITLE_FIXTURE = 'cues-ascii-6s.srt';
/** Vietnamese, Korean and an emoji, for the journey whose subject IS glyph coverage. */
export const UNICODE_SUBTITLE_FIXTURE = 'cues-6s.srt';
export const FIRST_CUE = 'First cue for the preview';
export const MEDIA_DURATION_SECONDS = 6;

const ACTIVATION_TIMEOUT_MS = 120_000;

/** Launch, clear first-run onboarding, and import the media fixture through the real controls. */
export const openProjectWithMedia = async () => {
  await openEditor();
  await clickControl('[data-input-tab="file-upload"]');
  await clickControl('.file-upload-input');

  await browser.waitUntil(
    async () => (await browser.execute(() => {
      const video = document.querySelector('video');
      return video !== null && Number.isFinite(video.duration);
    })),
    {
      timeout: ACTIVATION_TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: 'the selected media never became playable in the editor',
    },
  );
};

/**
 * Drop the subtitle fixture onto the real control and wait for its cues to be readable.
 *
 * The chooser's own input is hidden behind a button and WebDriver cannot fill an element it cannot
 * see. The drop handler is the same component reading the same bytes with the same reader, so the
 * import is the product's own; only the gesture differs.
 */
export const importSubtitles = async (fixture = SUBTITLE_FIXTURE) => {
  const subtitles = readFileSync(join(FIXTURE_ROOT, fixture), 'utf8');
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
  }, subtitles, fixture);

  if (dropped !== 'dropped') throw new Error(`the subtitle drop target was missing: ${dropped}`);

  await browser.waitUntil(
    async () => (await browser.execute(
      (cue) => (document.body?.innerText || '').includes(cue), FIRST_CUE,
    )),
    { timeout: 60_000, interval: 1_000, timeoutMsg: 'the imported subtitles never appeared' },
  );
};

/** Wait until the compositor has published a frame, which is the only proof a preview happened. */
export const waitForNativeFrame = async (timeout = 90_000) => {
  await browser.waitUntil(
    async () => (await browser.execute(
      () => document.querySelector('.native-composited-frame') !== null,
    )),
    { timeout, interval: 1_000, timeoutMsg: 'no native composited frame was ever published' },
  );
};

/**
 * Open the editor for one cue and replace its text.
 *
 * The component opens its editor on a DOUBLE CLICK of the cue text, and commits on blur. The event
 * is dispatched rather than driven through the pointer because the cue list scrolls independently
 * and the row a journey wants is routinely below the window; the handler, the editor and the commit
 * are all the product's own either way.
 */
export const editCueText = async (existing, replacement) => {
  const opened = await browser.execute((cue) => {
    const node = [...document.querySelectorAll('.lyric-text')]
      .find((candidate) => (candidate.innerText || '').includes(cue));
    if (node === undefined) return false;
    node.scrollIntoView({ block: 'center' });
    node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    return true;
  }, existing);
  if (!opened) throw new Error(`no cue on screen contained ${JSON.stringify(existing)}`);

  const editor = await $('.lyric-text-input');
  await editor.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'the cue editor never opened' });
  await editor.setValue(replacement);
  await browser.execute(() => document.querySelector('.lyric-text-input')?.blur());

  await browser.waitUntil(
    async () => (await browser.execute(
      (text) => (document.body?.innerText || '').includes(text), replacement,
    )),
    { timeout: 30_000, interval: 500, timeoutMsg: 'the edited cue text never appeared' },
  );
};

/** Whether the rendered page currently shows this text anywhere a customer could read it. */
export const showsText = async (text) => browser.execute(
  (needle) => (document.body?.innerText || '').includes(needle), text,
);
