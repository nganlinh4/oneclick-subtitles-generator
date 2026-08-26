import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { clickControl, openEditor } from './editor.js';
import { FIXTURE_ROOT } from './environment.js';

/* global $, DataTransfer, DragEvent, File, MouseEvent, browser, document, window */

/**
 * The steps every project-level journey has to perform before it can test anything of its own.
 *
 * Shared rather than repeated so a journey reads as the thing it is checking, and so a change to how
 * media or subtitles arrive is made once. Every step drives the real interface: nothing writes
 * project state, nothing is mocked, and the media is a real video fetched from a real URL by the
 * application's own downloader.
 */

/** Plain text, for journeys whose subject is not glyph coverage. */
export const SUBTITLE_FIXTURE = 'cues-ascii.srt';
/** Vietnamese, Korean, emoji, Arabic in brackets and mixed bidi, for the journey about coverage. */
export const UNICODE_SUBTITLE_FIXTURE = 'cues-unicode.srt';
/** Mixed Korean and Latin lines with the same shape as a real generated transcript. */
export const GEMINI_SHAPE_SUBTITLE_FIXTURE = 'cues-gemini-shape.srt';
export const FIRST_CUE = 'First cue for the preview';

const ACTIVATION_TIMEOUT_MS = 180_000;

/**
 * Launch, clear first-run onboarding, and open the real video through the real controls.
 *
 * THE MEDIA IS A REAL YOUTUBE VIDEO, not a synthetic clip: `realMedia.js` keeps a copy on disk,
 * obtained with the same yt-dlp the application installs for itself. So the decoder, the identity,
 * the artifacts and the preview all meet a real container with a real codec.
 *
 * The customer clicks the "Upload File" tab and the real drop zone, and the application runs its
 * actual `select_media` command, import, activation and identity code. The ONLY substitution is the
 * operating system's file dialog, which a WebDriver session cannot drive; the application resolves
 * the staged selection against a declared root and hands it to exactly the same `import_media_path`
 * a person's click produces.
 *
 * Acquiring a video from a URL is a different capability with a different journey — `urlToPreview`
 * — because "Download Only" saves to disk rather than loading into the editor.
 */
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
  await importSubtitleDocument(subtitles, fixture, FIRST_CUE);
};

/**
 * Drop an in-memory subtitle document through the same real editor boundary as a fixture.
 *
 * Kept separate so a diagnostic journey can replay a user's cue strings from a database opened
 * read-only without copying those strings into the repository or an evidence manifest.
 */
export const importSubtitleDocument = async (subtitles, name, expectedCue) => {
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
  }, subtitles, name);

  if (dropped !== 'dropped') throw new Error(`the subtitle drop target was missing: ${dropped}`);

  await browser.waitUntil(
    async () => (await browser.execute(
      (cue) => (document.body?.innerText || '').includes(cue), expectedCue,
    )),
    { timeout: 60_000, interval: 1_000, timeoutMsg: 'the imported subtitles never appeared' },
  );
};

/** Move the real player into a cue before asking the compositor for subtitle pixels. */
export const seekPreviewTo = async (seconds) => {
  await browser.execute((target) => {
    const video = document.querySelector('.video-preview video.video-player');
    if (video === null) throw new Error('the editor video is missing');
    // Wakeup counters read back by waitForCanvasSubtitleFrame's failure diagnostic: a stuck
    // compositor is only diagnosable if we know whether the seek ever presented a frame.
    const probe = { seeked: 0, rvfc: 0, nudged: false };
    window.__OSG_SEEK_PROBE__ = probe;
    video.addEventListener('seeked', () => { probe.seeked += 1; });
    if (typeof video.requestVideoFrameCallback === 'function') {
      const arm = () => video.requestVideoFrameCallback(() => { probe.rvfc += 1; arm(); });
      arm();
    }
    video.pause();
    video.currentTime = target;
  }, seconds);
};

/** Wait until the persistent canvas has drawn video plus a ready subtitle cue. */
export const waitForCanvasSubtitleFrame = async (timeout = 90_000) => {
  let last = null;
  try {
    await browser.waitUntil(
      async () => {
        last = await browser.execute(
      () => {
        const surface = document.querySelector('.video-preview canvas[data-osg-preview-engine="canvas-atlas"]');
        const state = document.querySelector('.video-preview [data-osg-preview]')
          ?.getAttribute('data-osg-preview');
        const video = document.querySelector('.video-preview video.video-player');
        return {
          ready: surface !== null
            && Number(surface.dataset.osgFrameRevision ?? 0) > 0
            && state === 'ready',
          state: state ?? null,
          canvas: surface === null ? null : {
            width: surface.width,
            height: surface.height,
            clientWidth: surface.clientWidth,
            clientHeight: surface.clientHeight,
            revision: surface.dataset.osgFrameRevision ?? null,
            cue: surface.dataset.osgCueIndex ?? null,
          },
          video: video === null ? null : {
            readyState: video.readyState,
            networkState: video.networkState,
            paused: video.paused,
            currentTime: video.currentTime,
            duration: video.duration,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            currentSrc: video.currentSrc,
            error: video.error === null ? null : {
              code: video.error.code,
              message: video.error.message,
            },
          },
        };
      },
        );
        return last.ready;
      },
      { timeout, interval: 250, timeoutMsg: 'the canvas compositor never drew a ready subtitle frame' },
    );
  } catch (error) {
    // Failure diagnostic only: report which wakeups fired, then test whether one more presented
    // frame recovers the compositor. The journey still fails; the nudge result names the defect
    // class (missed one-shot wakeup vs. a dead pipeline) instead of a bare timeout.
    let nudge = null;
    try {
      nudge = await browser.execute(() => {
        const video = document.querySelector('.video-preview video.video-player');
        const probe = window.__OSG_SEEK_PROBE__ ?? null;
        if (video !== null) {
          if (probe !== null) probe.nudged = true;
          video.currentTime += 0.01;
        }
        return probe;
      });
      await browser.pause(2_000);
      nudge = {
        probe: nudge,
        afterNudge: await browser.execute(() => ({
          state: document.querySelector('.video-preview [data-osg-preview]')
            ?.getAttribute('data-osg-preview') ?? null,
          revision: document.querySelector(
            '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]',
          )?.dataset.osgFrameRevision ?? null,
          probe: window.__OSG_SEEK_PROBE__ ?? null,
        })),
      };
    } catch { /* diagnostics stay best-effort */ }
    throw new Error(
      `${error.message}; last=${JSON.stringify(last)}; nudge=${JSON.stringify(nudge)}`,
      { cause: error },
    );
  }
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
  await editor.click();
  await editor.setValue(replacement);
  // Commit through the editor's customer-facing keyboard contract. Calling `HTMLElement.blur()`
  // from script is not equivalent when WebDriver populated a controlled textarea without making
  // it the active element: the value changed, but React received no blur and the editor stayed open
  // forever. Enter is explicitly handled by `LyricItem` and exercises the same submit path a user
  // reaches.
  await browser.keys('Enter');

  // What the editor and the list actually hold. "The edited text never appeared" is true of a
  // commit that was refused, of a value that never reached the input, and of an editor that stayed
  // open -- three different problems that need three different fixes.
  const editorState = () => browser.execute((text) => {
    const input = document.querySelector('.lyric-text-input');
    const rows = [...document.querySelectorAll('.lyric-text')]
      .map((node) => (node.innerText || '').trim()).slice(0, 6);
    return {
      editorStillOpen: input !== null,
      editorValue: input === null ? null : input.value,
      firstRows: rows,
      bodyHasReplacement: (document.body?.innerText || '').includes(text),
    };
  }, replacement);

  let seen = await editorState();
  try {
    await browser.waitUntil(async () => {
      seen = await editorState();
      return seen.bodyHasReplacement && !seen.editorStillOpen;
    }, {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: 'the edited cue text never appeared',
    });
  } catch (error) {
    seen = await editorState();
    throw new Error(`the edited cue text never appeared. last: ${JSON.stringify(seen)}`, {
      cause: error,
    });
  }
};

/** Whether the rendered page currently shows this text anywhere a customer could read it. */
export const showsText = async (text) => browser.execute(
  (needle) => (document.body?.innerText || '').includes(needle), text,
);
