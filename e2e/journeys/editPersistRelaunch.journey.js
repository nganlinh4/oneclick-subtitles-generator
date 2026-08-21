// A customer edits a cue, saves, closes the application, and finds their work again.
//
// Durability is the promise this checks, and durability is not something the interface can vouch
// for: a cue rendered on screen proves React ran. So every claim here has a second, independent
// witness — the application's own database, read directly and read-only after the fact.
//
// The scenario runner invokes this file twice against one isolated profile. The WDIO service stops
// the seed process before it starts the verification process, so persistence is never inferred from
// a fresh WebDriver session attached to the same still-running application.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl, openEditor } from '../support/editor.js';
import { REAL_VIDEO } from '../support/realMedia.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';
import {
  FIRST_CUE,
  editCueText,
  importSubtitles,
  openProjectWithMedia,
  showsText,
  waitForNativeFrame,
} from '../support/workflow.js';

const EDITED = 'Edited first cue';
const PHASE = process.env.OSG_E2E_PERSISTENCE_PHASE;
const WORKFLOW = 'edit-persist-relaunch';

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
    assert.ok(
      PHASE === 'seed' || PHASE === 'verify',
      'run this persistence journey through scenarios/editPersistRelaunch.mjs',
    );

    if (PHASE === 'verify') {
      const saved = durableState(root);
      assert.equal(saved.counts.projects, 1, 'the prior process must have created one project');
      assert.equal(saved.counts.media, 1, 'the prior process must have recorded one media asset');
      assert.ok(saved.cues.some((cue) => cue.text === EDITED), 'the saved edit is absent at startup');

      await openEditor();
      let seen = null;
      await browser.waitUntil(async () => {
        seen = await inspect();
        return seen.hasVideoElement && (await showsText(EDITED));
      }, {
        timeout: 180_000,
        interval: 2_000,
        timeoutMsg: () => `the project did not restore in a new process. last: ${JSON.stringify(seen)}`,
      });
      assert.ok(
        Math.abs(seen.videoDuration - REAL_VIDEO.durationSeconds)
          <= REAL_VIDEO.durationToleranceSeconds,
        `the restored project must carry the same media, not ${seen.videoDuration}s`,
      );
      assert.deepEqual(seen.errors, [], 'a restored project must not show an error');
      await waitForNativeFrame(120_000);
      const restored = durableState(root);
      assert.equal(restored.projects[0].id, saved.projects[0].id, 'the project identity changed');
      assert.equal(restored.media[0].id, saved.media[0].id, 'the media identity changed');
      assert.equal(
        restored.media[0].content_hash,
        saved.media[0].content_hash,
        'the media content identity changed',
      );
      assert.equal(restored.counts.projects, 1, 'startup created a duplicate project');
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '03-restored-project',
        description: 'A second desktop process restored the edited cue, playable media, and native preview.',
        details: { projectId: restored.projects[0].id, cueCount: restored.counts.cues },
        focusSelector: '.lyrics-container-wrapper',
      });
      return;
    }

    await openProjectWithMedia();
    await importSubtitles();
    await waitForNativeFrame();
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-imported-project',
      description: 'Real local media and imported subtitles are playable and natively composited.',
      focusSelector: '.video-preview .video-container',
    });

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
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-edit-saved',
      description: 'The edited cue survived undo/redo and reached the durable saved state.',
      details: { editedText: EDITED, revision: saved.latestRevision.revision },
      focusSelector: '.lyrics-container-wrapper',
    });

  });
});
