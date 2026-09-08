import { strict as assert } from 'node:assert';
import process from 'node:process';
import { join } from 'node:path';
import { durableState, durableTranscriptWords, withDatabase } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { openProjectWithMedia, seekPreviewTo, waitForCanvasSubtitleFrame } from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';
import { extractFrame, listMediaFiles, newestMediaFile, probeMedia } from '../support/nativeMediaOracle.js';

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
    await clickControl('[role="option"][data-value="gemini-transcribe-live"]');
    await (await $('#transcribe-window')).waitForExist({ timeout: 10_000 });
    const controls = await browser.execute(() => ({
      replacement: !!document.querySelector('.create-subtitles-modal, [data-task-tab], [data-editor-view], .caption-grouping-toolbar'),
      videoOptions: !!document.querySelector('#generation-model, #generation-fps'),
      originalModal: !!document.querySelector('.video-processing-modal'),
    }));
    assert.deepEqual(controls, { replacement: false, videoOptions: false, originalModal: true });
    await captureWorkflowStep({ workflow: WORKFLOW, step: '03-transcribe-method-options', description: 'Transcribe selected as an ordinary method in the original modal.' });
    await clickControl('[data-osg-action="process-subtitles"]');
    await (await $('[data-osg-live-draft]')).waitForDisplayed({ timeout: 90_000 });
    await captureWorkflowStep({ workflow: WORKFLOW, step: '04-live-draft', focusSelector: '[data-osg-live-draft]', description: 'Real Live text before timestamped captions; drafts are outside saved cues.' });
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
    await captureWorkflowStep({ workflow: WORKFLOW, step: '05-native-captions-in-original-editor', description: 'Provider captions in the original editor and composited video preview.' });
    assert.equal(await (await $('[data-osg-live-draft]')).isExisting(), false, 'completed Live drafts must be cleared');
    const originalText = durableState(root).cues.map((cue) => cue.text);
    await clickControl('[data-osg-action="subtitle-speakers"]');
    if (await (await $('#speaker-scope')).isEnabled()) {
      await clickControl('#speaker-scope');
      await clickControl('[role="option"][data-value="all"]');
    }
    await clickControl('#speaker-assignment');
    await clickControl('[role="option"][data-value="new"]');
    await (await $('#speaker-new-name')).setValue('Min');
    await clickControl('#speaker-label-style');
    await clickControl('[role="option"][data-value="colon"]');
    await captureWorkflowStep({ workflow: WORKFLOW, step: '06-global-speaker-controls', description: 'Global speaker assignment and label preview using the existing dialog styling.' });
    await clickControl('.speaker-apply-btn');
    const savedSpeakers = () => withDatabase(root, (db) => db.prepare('SELECT metadata_json FROM cues ORDER BY ordinal').all().map((row) => JSON.parse(row.metadata_json).speaker));
    const allSpeakersMatch = (predicate) => {
      const speakers = savedSpeakers();
      return speakers.length === originalText.length && speakers.every(predicate);
    };
    await browser.waitUntil(() => allSpeakersMatch((speaker) => speaker?.name === 'Min' && speaker.labelStyle === 'colon'), { timeout: 15000 });
    assert.deepEqual(durableState(root).cues.map((cue) => cue.text), originalText, 'speaker formatting must not rewrite subtitle text');
    await clickControl('.undo-btn');
    await browser.waitUntil(() => allSpeakersMatch((speaker) => speaker?.name !== 'Min'), { timeout: 15000 });
    await clickControl('.redo-btn');
    await browser.waitUntil(() => allSpeakersMatch((speaker) => speaker?.name === 'Min'), { timeout: 15000 });
    assert.deepEqual(durableState(root).cues.map((cue) => cue.text), originalText, 'undo/redo must preserve every cue');
    await seekPreviewTo((words[0].startMs + words[0].endMs) / 2000);
    await waitForCanvasSubtitleFrame();
    await captureWorkflowStep({ workflow: WORKFLOW, step: '07-speaker-label-in-preview', description: 'Speaker label in the composited video after a real undo/redo cycle; editor text remains unchanged.' });
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    assert.ok(destination, 'requires isolated export destination');
    await clickControl('.render-video-toggle');
    await (await $('.video-rendering-section.expanded .native-render-controls')).waitForDisplayed({ timeout: 60000 });
    await clickControl('.video-rendering-section.expanded button[data-osg-action="render-video"]');
    const terminal = await $('.video-rendering-section .queue-item.completed, .video-rendering-section .queue-item.failed');
    await terminal.waitForDisplayed({ timeout: 600000 });
    assert.match(await terminal.getAttribute('class'), /(?:^|\s)completed(?:\s|$)/, 'native export must complete');
    const beforeFiles = listMediaFiles(destination);
    await clickControl('.video-rendering-section .queue-item.completed .download-btn-success');
    let exported;
    await browser.waitUntil(() => (exported = newestMediaFile(destination, beforeFiles)) !== null, { timeout: 120000, interval: 1000 });
    const probe = probeMedia(exported);
    assert.ok(probe.streams.some((stream) => stream.codec_type === 'video'));
    assert.ok(probe.streams.some((stream) => stream.codec_type === 'audio'));
    const frame = join(root, 'evidence', 'speaker-export-frame.png');
    extractFrame(exported, (words[0].startMs + words[0].endMs) / 2000, frame);
    copyWorkflowArtifact({ workflow: WORKFLOW, name: 'speaker-export-frame', source: frame, description: 'Independently decoded exported frame for visual speaker-label verification.' });
    await captureWorkflowStep({ workflow: WORKFLOW, step: '08-export-complete', description: 'Real native export saved and independently decoded with video and audio streams.' });
  });
});
