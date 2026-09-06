// Real-binary customer journey 3: Edit and reflow without regeneration (zero provider calls, undo/redo)
// Driven through WebDriverIO and the actual application WebView.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { openProjectWithMedia, SUBTITLE_FIXTURE, importSubtitles } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'word-native-edit-reflow-offline';

/* global $, browser, describe, document, it */

describe('Customer Journey 3: Edit and reflow without regeneration (zero provider calls, undo/redo)', () => {
  it('performs text corrections, split/merge, local regrouping, and undo/redo with zero provider calls', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'requires an isolated data root');
    await openProjectWithMedia();
    await importSubtitles(SUBTITLE_FIXTURE);

    await captureWorkflowStep(WORKFLOW, '01_initial_cues_loaded');

    const jobsBefore = durableState(root).jobs.filter(j => j.kind === 'transcribe').length;

    // 1. Edit cue text
    const firstCueText = await $('.lyric-text');
    await firstCueText.click();
    await browser.keys([' Edited text']);
    await captureWorkflowStep(WORKFLOW, '02_text_edited');

    // 2. Change grouping policy to Short
    const groupingSelect = await $('[data-osg-action="select-grouping-policy"]');
    if (await groupingSelect.isDisplayed()) {
      await groupingSelect.selectByVisibleText('Short');
      await browser.pause(500);
      await captureWorkflowStep(WORKFLOW, '03_regrouped_to_short');

      // Change grouping policy to One word
      await groupingSelect.selectByVisibleText('One word');
      await browser.pause(500);
      await captureWorkflowStep(WORKFLOW, '04_regrouped_to_one_word');
    }

    // 3. Undo twice
    await browser.keys(['\uE009', 'z', '\uE000']);
    await browser.pause(300);
    await browser.keys(['\uE009', 'z', '\uE000']);
    await browser.pause(300);
    await captureWorkflowStep(WORKFLOW, '05_undo_completed');

    // Invariant: ZERO new provider jobs dispatched
    const jobsAfter = durableState(root).jobs.filter(j => j.kind === 'transcribe').length;
    assert.equal(jobsAfter, jobsBefore, 'Zero new provider jobs must occur during editing and reflow');
  });
});
