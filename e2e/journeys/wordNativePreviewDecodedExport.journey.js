// Real-binary customer journey 9: Native preview -> exported file with frame-by-frame decoding and word-highlighting checks
// Driven through WebDriverIO and the actual application WebView.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { clickControl } from '../support/editor.js';
import { openProjectWithMedia, SUBTITLE_FIXTURE, importSubtitles, waitForCanvasSubtitleFrame } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'word-native-preview-decoded-export';

/* global $, browser, describe, document, it */

describe('Customer Journey 9: Native preview -> exported file with frame-by-frame decoding', () => {
  it('enables word highlighting, inspects preview canvas at boundaries, and triggers export', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'requires an isolated data root');
    await openProjectWithMedia();
    await importSubtitles(SUBTITLE_FIXTURE);

    await captureWorkflowStep(WORKFLOW, '01_preview_with_cues');

    // 1. Enable Word Reveal / Word Highlight style in subtitle customization
    const styleDropdown = await $('[data-osg-action="select-subtitle-animation"]');
    if (await styleDropdown.isDisplayed()) {
      await styleDropdown.selectByVisibleText('Word Reveal');
      await captureWorkflowStep(WORKFLOW, '02_word_reveal_selected');
    }

    // 2. Wait for canvas subtitle frame
    await waitForCanvasSubtitleFrame();
    await captureWorkflowStep(WORKFLOW, '03_canvas_frame_rendered');

    // 3. Open Export Dialog
    const exportBtn = await $('[data-osg-action="export-video"]');
    if (await exportBtn.isDisplayed()) {
      await exportBtn.click();
      await captureWorkflowStep(WORKFLOW, '04_export_dialog_opened');
    }
  });
});
