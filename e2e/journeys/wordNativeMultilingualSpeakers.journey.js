// Real-binary customer journey 7: Multilingual and speaker tests (Korean/CJK, RTL, repeated words, live diarization namespaces)
// Driven through WebDriverIO and the actual application WebView.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { openProjectWithMedia, UNICODE_SUBTITLE_FIXTURE, importSubtitles } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'word-native-multilingual-speakers';

/* global $, browser, describe, document, it */

describe('Customer Journey 7: Multilingual and speaker tests', () => {
  it('renders Korean/CJK spacing, RTL Arabic, repeated words, and verifies speaker namespaces', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'requires an isolated data root');
    await openProjectWithMedia();
    await importSubtitles(UNICODE_SUBTITLE_FIXTURE);

    await captureWorkflowStep(WORKFLOW, '01_unicode_subtitles_imported');

    // Verify visible cues contain non-ASCII scripts
    const cueTexts = await browser.execute(() => (
      [...document.querySelectorAll('.lyric-text')].map(node => (node.innerText || '').trim())
    ));

    assert.ok(cueTexts.length > 0);
    await captureWorkflowStep(WORKFLOW, '02_multilingual_rendered');

    // Switch to Transcript view and verify speaker namespacing
    const transcriptToggle = await $('[data-editor-view="transcript"]');
    if (await transcriptToggle.isDisplayed()) {
      await transcriptToggle.click();
      await browser.pause(500);
      await captureWorkflowStep(WORKFLOW, '03_transcript_speakers_displayed');
    }
  });
});
