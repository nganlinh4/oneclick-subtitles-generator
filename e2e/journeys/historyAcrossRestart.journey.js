import { strict as assert } from 'node:assert';
import process from 'node:process';
import { durableState } from '../support/database.js';
import { clickControl, openEditor } from '../support/editor.js';
import { FIRST_CUE, editCueText, importSubtitles, openProjectWithMedia, showsText } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const EDITED = 'Edited first cue';
const phase = process.env.OSG_E2E_PERSISTENCE_PHASE;
const controls = () => browser.execute(() => ({
  undo: document.querySelector('.undo-btn')?.disabled === false,
  redo: document.querySelector('.redo-btn')?.disabled === false,
}));

describe('durable editor history across a full process restart', () => {
  it('restores redo and updates both text and controls when redo completes', async () => {
    assert.ok(phase === 'seed' || phase === 'verify');
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root);
    if (phase === 'seed') {
      await openProjectWithMedia();
      await importSubtitles();
      await editCueText(FIRST_CUE, EDITED);
      await browser.waitUntil(() => durableState(root).cues.some(cue => cue.text === EDITED), { timeout: 30_000 });
      await clickControl('.undo-btn');
      await browser.waitUntil(async () => await showsText(FIRST_CUE)
        && !durableState(root).cues.some(cue => cue.text === EDITED), { timeout: 30_000 });
      assert.deepEqual(await controls(), { undo: false, redo: true });
    } else {
      await openEditor();
      await browser.waitUntil(async () => await showsText(FIRST_CUE) && (await controls()).redo, { timeout: 60_000 });
      assert.deepEqual(await controls(), { undo: false, redo: true });
      await clickControl('.redo-btn');
      await browser.waitUntil(async () => await showsText(EDITED)
        && durableState(root).cues.some(cue => cue.text === EDITED), { timeout: 30_000 });
      await browser.waitUntil(async () => {
        const state = await controls();
        return state.undo && !state.redo;
      }, { timeout: 30_000, timeoutMsg: 'redo committed text but left stale visible history controls' });
    }
    await captureWorkflowStep({ workflow: 'history-across-restart', step: phase,
      description: phase === 'seed' ? 'Undo committed before closing the process.' : 'Redo after reopening committed and updated both history controls.',
      details: { controls: await controls() }, focusSelector: '.lyrics-container-wrapper' });
  });
});
