/* global $, browser, describe, document, it */

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState, durableTranscriptionRules } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { openProjectWithMedia, seekPreviewTo, waitForCanvasSubtitleFrame } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'gemini-video-analysis-success';
const TERMINAL = new Set(['failed', 'cancelled', 'interrupted']);
const uuidIdentity = (value) => String(value ?? '').replaceAll('-', '').toLowerCase();

const surface = () => browser.execute(() => ({
  analysisProcessing: document.querySelector('.video-analysis-button')?.classList.contains('processing') ?? null,
  hasAnalysis: document.querySelector('.video-analysis-button')?.classList.contains('has-analysis') ?? null,
  rulesEditor: document.querySelector('.rules-editor-modal') !== null,
  errorToasts: [...document.querySelectorAll('.toast-item.live .toast-error')]
    .map((node) => (node.innerText || node.textContent || '').replace(/\s+/gu, ' ').trim()),
  inlineErrors: [...document.querySelectorAll('.video-container .error, .processing-error')]
    .map((node) => (node.innerText || node.textContent || '').replace(/\s+/gu, ' ').trim()),
}));

describe('live Gemini video analysis becomes durable transcription guidance', () => {
  it('analyzes real media, saves project-owned rules, uses them, and draws the result', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the live analysis journey requires an isolated root');
    await openProjectWithMedia();
    const enrollment = await enrollGeminiCredentials({ limit: 20 });
    assert.equal(enrollment.enrolled, 20);

    const before = durableState(root);
    const priorAnalysis = new Set(before.jobs.filter(({ kind }) => kind === 'analyzeSubtitles').map(({ id }) => id));
    await clickControl('.video-analysis-button');

    let analysisJob = null;
    let analysisSurface = null;
    await browser.waitUntil(async () => {
      analysisSurface = await surface();
      const jobs = durableState(root).jobs.filter(({ id, kind }) => (
        kind === 'analyzeSubtitles' && !priorAnalysis.has(id)
      ));
      assert.ok(jobs.length <= 1, `one analysis click created multiple jobs: ${JSON.stringify(jobs)}`);
      [analysisJob = null] = jobs;
      if (analysisSurface.errorToasts.length > 0 || TERMINAL.has(analysisJob?.state)) {
        throw new Error(`live video analysis terminated: ${JSON.stringify({ analysisJob, analysisSurface })}`);
      }
      return analysisJob?.state === 'succeeded'
        && analysisSurface.rulesEditor
        && analysisSurface.hasAnalysis;
    }, {
      timeout: 15 * 60_000,
      interval: 1_000,
      timeoutMsg: 'Gemini video analysis never produced editable project rules',
    });

    const rows = durableTranscriptionRules(root).filter(({ transcriptionRules }) => transcriptionRules !== null);
    assert.equal(rows.length, 1, 'analysis did not persist exactly one project-owned rule set');
    assert.equal(uuidIdentity(rows[0].analysis?.providerJobId), uuidIdentity(analysisJob.id),
      'the persisted analysis does not own the succeeded provider job');
    assert.ok(Object.keys(rows[0].transcriptionRules).length > 0,
      'the provider analysis persisted an empty rule object');
    const footer = await browser.execute(() => {
      const root = document.querySelector('.rules-editor-modal').getBoundingClientRect();
      return [...document.querySelectorAll('.rules-editor-modal > .modal-footer button')].map(button => {
        const rect = button.getBoundingClientRect();
        return { top: rect.top, bottomGap: root.bottom - rect.bottom, rightGap: root.right - rect.right };
      });
    });
    assert.equal(footer.length, 2);
    assert.ok(footer.every(button => button.bottomGap >= 12 && button.rightGap >= 12), 'rules footer actions touch the modal edge');
    assert.ok(Math.abs(footer[0].top - footer[1].top) <= 2, 'rules footer actions are unexpectedly stacked');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-live-analysis-rules',
      description: 'Gemini analyzed the real video and opened its durable project-owned transcription rules.',
      details: {
        enrolledCredentialCount: enrollment.enrolled,
        providerJobState: analysisJob.state,
        ruleSections: Object.keys(rows[0].transcriptionRules),
      },
      focusSelector: '.rules-editor-modal',
    });

    await clickControl('.rules-editor-modal .save-button');
    await $('.rules-editor-modal').waitForExist({ reverse: true, timeout: 30_000 });
    await clickControl('[data-osg-action="generate-subtitles"]');
    const timeline = await $('.subtitle-timeline');
    await timeline.waitForDisplayed({ timeout: 60_000 });
    await timeline.click();
    await browser.keys(['\uE009', 'a', '\uE000']);
    const method = await $('[data-transcription-method="new"]');
    await method.waitForClickable({ timeout: 60_000 });
    await method.click();

    const rulesToggle = await $('#use-transcription-rules');
    await rulesToggle.waitForDisplayed({ timeout: 30_000 });
    assert.equal(await rulesToggle.getAttribute('disabled'), null,
      'successful analysis left the transcription-rules control disabled');
    const rulesSelected = () => browser.execute(
      () => document.querySelector('#use-transcription-rules')?.selected === true,
    );
    if (!(await rulesSelected())) await rulesToggle.click();
    await browser.waitUntil(rulesSelected, {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'the customer could not enable the analyzed transcription rules',
    });

    const beforeTranscription = durableState(root);
    const priorTranscription = new Set(
      beforeTranscription.jobs.filter(({ kind }) => kind === 'transcribe').map(({ id }) => id),
    );
    await clickControl('[data-osg-action="process-subtitles"]');
    let transcriptionJob = null;
    let resultSurface = null;
    let result = null;
    await browser.waitUntil(async () => {
      resultSurface = await surface();
      result = durableState(root);
      const jobs = result.jobs.filter(({ id, kind }) => kind === 'transcribe' && !priorTranscription.has(id));
      assert.ok(jobs.length <= 1, `one Process click created multiple jobs: ${JSON.stringify(jobs)}`);
      [transcriptionJob = null] = jobs;
      if (resultSurface.errorToasts.length > 0 || TERMINAL.has(transcriptionJob?.state)) {
        throw new Error(`rule-guided Gemini transcription terminated: ${JSON.stringify({ transcriptionJob, resultSurface })}`);
      }
      return transcriptionJob?.state === 'succeeded' && result.counts.cues > 0;
    }, {
      timeout: 15 * 60_000,
      interval: 1_000,
      timeoutMsg: 'rule-guided Gemini transcription never produced durable cues',
    });
    assert.deepEqual(resultSurface.inlineErrors, []);
    const first = result.cues[0];
    await seekPreviewTo((Number(first.start_ms) + Number(first.end_ms)) / 2_000);
    await waitForCanvasSubtitleFrame(180_000);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-rule-guided-cues-drawn',
      description: 'The analyzed rules were enabled for Gemini transcription; its durable cues draw in the native preview.',
      details: { cueCount: result.counts.cues, providerJobState: transcriptionJob.state },
      focusSelector: '.video-preview .video-container',
    });
  });
});
