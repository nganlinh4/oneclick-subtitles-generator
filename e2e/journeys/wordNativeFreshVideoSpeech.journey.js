import { strict as assert } from 'node:assert';
import process from 'node:process';
import { durableState, durableTranscriptWords } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { openProjectWithMedia, seekPreviewTo, waitForCanvasSubtitleFrame } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

/* global $, browser, describe, document, it */
const WORKFLOW = process.env.OSG_E2E_WORKFLOW || 'word-native-fresh-video-speech';

describe('Transcribe in the original generation modal and subtitle editor', () => {
  it('keeps the original controls and displays native transcription as ordinary editable cues', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'requires an isolated data root');
    await openProjectWithMedia();
    await enrollGeminiCredentials({ limit: 1 });
    await captureWorkflowStep({ workflow: WORKFLOW, step: '01-original-editor', description: 'Original editor with real imported video.' });
    await clickControl('[data-osg-action="generate-subtitles"]');
    await clickControl('.subtitle-timeline');
    await browser.keys(['\uE009', 'a', '\uE000']);
    await clickControl('[data-transcription-method="new"]');
    await (await $('#generation-model')).waitForDisplayed({ timeout: 30_000 });
    await captureWorkflowStep({ workflow: WORKFLOW, step: '02-original-gemini-options', description: 'Original Gemini video, model and prompt controls.' });

    await clickControl('.header-switch-group .custom-dropdown-button');
    await clickControl('[role="option"][data-value="gemini-transcribe"]');
    await (await $('#transcribe-window')).waitForExist({ timeout: 10_000 });
    const controls = await browser.execute(() => ({
      replacement: !!document.querySelector('.create-subtitles-modal, [data-task-tab], [data-editor-view], .caption-grouping-toolbar'),
      videoOptions: !!document.querySelector('#generation-model, #generation-fps'),
      originalModal: !!document.querySelector('.video-processing-modal'),
    }));
    assert.deepEqual(controls, { replacement: false, videoOptions: false, originalModal: true });
    await captureWorkflowStep({ workflow: WORKFLOW, step: '03-transcribe-method-options', description: 'Transcribe selected as an ordinary method in the original modal.' });
    await clickControl('[data-osg-action="process-subtitles"]');
    await browser.waitUntil(async () => {
      const state = durableState(root);
      return state.counts.cues > 0 && durableTranscriptWords(root).length > 0
        && await browser.execute(() => !document.querySelector('[data-osg-action="generate-subtitles"]')?.classList.contains('processing'));
    }, { timeout: 240_000, interval: 1_000, timeoutMsg: 'Transcribe did not persist captions and real word timestamps' });
    await (await $('.lyric-text')).waitForDisplayed({ timeout: 15_000 });
    const words = durableTranscriptWords(root);
    assert.ok(words.every((word) => word.endMs >= word.startMs && word.text.trim()), 'invalid persisted words');
    await seekPreviewTo((words[0].startMs + words[0].endMs) / 2000);
    await waitForCanvasSubtitleFrame();
    await captureWorkflowStep({ workflow: WORKFLOW, step: '04-native-captions-in-original-editor', description: 'Provider captions in the original editor and composited video preview.' });
  });
});
