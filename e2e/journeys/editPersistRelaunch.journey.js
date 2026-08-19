// A customer edits a cue, saves, closes the application, and finds their work again.
//
// Durability is the promise this checks, and durability is not something the interface can vouch
// for: a cue rendered on screen proves React ran. So every claim here has a second, independent
// witness — the application's own database, read directly and read-only after the fact.
//
// The relaunch is a real one. `reloadSession` starts a new process against the same isolated
// profile, which is what closing and reopening the application is on a customer's machine.

import { strict as assert } from 'node:assert';

import { durableState } from '../support/database.js';
import { clickControl, openEditor } from '../support/editor.js';
import { REAL_VIDEO } from '../support/realMedia.js';
import {
  FIRST_CUE,
  editCueText,
  importSubtitles,
  openProjectWithMedia,
  showsText,
  waitForNativeFrame,
} from '../support/workflow.js';

const EDITED = 'Edited first cue';

const inspect = () => browser.execute(() => {
  const video = document.querySelector('video');
  return {
    errors: [...document.querySelectorAll('.error, [role="alert"]')]
      .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 6),
    hasVideoElement: video !== null,
    videoDuration: Number.isFinite(video?.duration) ? video.duration : null,
    hasNativeFrame: document.querySelector('.native-composited-frame') !== null,
  };
});

describe('a customer edits a cue and reopens the application', () => {
  it('keeps the edit, the project and the media across a relaunch', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the harness must have an isolated data root');

    await openProjectWithMedia();
    await importSubtitles();
    await waitForNativeFrame();

    // --- edit and history -----------------------------------------------------------------------
    await editCueText(FIRST_CUE, EDITED);

    // History is a customer-visible promise, so it is exercised rather than assumed.
    await clickControl('.undo-btn');
    await browser.waitUntil(async () => !(await showsText(EDITED)), {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: 'undo did not take the edit back',
    });
    await clickControl('.redo-btn');
    await browser.waitUntil(async () => showsText(EDITED), {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: 'redo did not restore the edit',
    });

    await clickControl('.lyrics-save-btn');

    // --- the durable oracle ---------------------------------------------------------------------
    let saved = null;
    await browser.waitUntil(async () => {
      saved = durableState(root);
      return saved.cues.some((cue) => cue.text === EDITED);
    }, {
      timeout: 60_000,
      interval: 2_000,
      timeoutMsg: () => 'the edited cue never reached the database. cues on record: '
        + JSON.stringify(saved?.cues.map((cue) => cue.text) ?? []),
    });

    console.log(`durable state after save: ${JSON.stringify(saved.counts)}`);
    assert.equal(saved.counts.projects, 1, 'exactly one project must exist');
    assert.equal(saved.counts.media, 1, 'exactly one media asset must be recorded');
    assert.ok(saved.counts.cues >= 3, 'all three imported cues must be recorded');
    assert.ok(saved.latestRevision !== null, 'a saved project must have a revision');

    const projectId = saved.projects[0].id;
    const mediaId = saved.media[0].id;
    const mediaHash = saved.media[0].content_hash;

    // --- relaunch -------------------------------------------------------------------------------
    await browser.reloadSession();
    await openEditor();

    let seen = null;
    await browser.waitUntil(async () => {
      seen = await inspect();
      // The edited text is the evidence, not the absence of the original: waiting for something to
      // disappear also succeeds when the project failed to load at all.
      return seen.hasVideoElement && (await showsText(EDITED));
    }, {
      timeout: 180_000,
      interval: 2_000,
      timeoutMsg: () => `the project did not restore after relaunch. last: ${JSON.stringify(seen)}`,
    });

    console.log(`after relaunch: ${JSON.stringify(seen, null, 2)}`);
    assert.ok(
      Math.abs(seen.videoDuration - REAL_VIDEO.durationSeconds) <= REAL_VIDEO.durationToleranceSeconds,
      `the restored project must carry the same media, not ${seen.videoDuration}s`,
    );
    assert.deepEqual(seen.errors, [], 'a restored project must not show an error');

    // The preview has to come back too, not just the text.
    await waitForNativeFrame(120_000);

    const restored = durableState(root);
    assert.equal(restored.projects[0].id, projectId, 'the same project must be restored');
    assert.equal(restored.media[0].id, mediaId, 'the same media identity must be restored');
    assert.equal(restored.media[0].content_hash, mediaHash, 'the media content identity must match');
    assert.ok(
      restored.cues.some((cue) => cue.text === EDITED),
      'the edit must still be there after relaunch',
    );
    assert.equal(
      restored.counts.projects, 1,
      'a relaunch must reopen the project, not create another one',
    );
  });
});
