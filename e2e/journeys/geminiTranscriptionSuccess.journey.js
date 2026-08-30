/* global $, browser, describe, document, it */

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import {
  openProjectWithMedia,
  seekPreviewTo,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'gemini-transcription-success';
const terminalStates = new Set(['failed', 'cancelled', 'interrupted']);

const surfaceState = () => browser.execute(() => ({
  cues: [...document.querySelectorAll('.lyric-text')]
    .map((node) => (node.innerText || '').trim()).filter(Boolean),
  errorToasts: [...document.querySelectorAll('.toast-error')]
    .map((node) => (node.querySelector('p')?.innerText || node.innerText || '').trim()).filter(Boolean),
  inlineErrors: [...document.querySelectorAll('.video-container .error, .processing-error')]
    .map((node) => (node.innerText || '').trim()).filter(Boolean),
  processing: document.querySelector('[data-osg-action="generate-subtitles"]')
    ?.classList.contains('processing') === true,
}));

describe('a customer generates subtitles through live Gemini', () => {
  it('enrols the reviewed pool, transcribes real media, persists cues and draws them', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the Gemini transcription journey requires an isolated root');
    await openProjectWithMedia();
    const enrollment = await enrollGeminiCredentials({ limit: 20 });
    assert.equal(enrollment.enrolled, 20, 'the complete reviewed Gemini pool was not enrolled');

    const before = durableState(root);
    const priorJobs = new Set(before.jobs.filter(({ kind }) => kind === 'transcribe').map(({ id }) => id));
    await clickControl('[data-osg-action="generate-subtitles"]');
    const timeline = await $('.subtitle-timeline');
    await timeline.waitForDisplayed({ timeout: 60_000 });
    await timeline.click();
    await browser.keys(['\uE009', 'a', '\uE000']);

    const method = await $('[data-transcription-method="new"]');
    await method.waitForClickable({ timeout: 60_000 });
    assert.equal(await method.getAttribute('data-method-available'), 'true');
    await method.click();
    await clickControl('[data-osg-action="process-subtitles"]');

    let surface = null;
    let job = null;
    let durable = null;
    await browser.waitUntil(async () => {
      surface = await surfaceState();
      durable = durableState(root);
      const jobs = durable.jobs.filter(({ id, kind }) => kind === 'transcribe' && !priorJobs.has(id));
      assert.ok(jobs.length <= 1, `one Process click created multiple Gemini jobs: ${JSON.stringify(jobs)}`);
      [job = null] = jobs;
      if (surface.errorToasts.length > 0 || terminalStates.has(job?.state)) {
        throw new Error(`Gemini transcription terminated: ${JSON.stringify({ job, surface })}`);
      }
      return job?.state === 'succeeded'
        && surface.processing === false
        && surface.cues.length > 0
        && durable.counts.cues > 0;
    }, {
      timeout: 10 * 60_000,
      interval: 1_000,
      timeoutMsg: 'Gemini transcription never produced a succeeded durable cue track',
    });

    assert.deepEqual(surface.inlineErrors, [], 'Gemini transcription painted an inline error');
    assert.equal(durable.latestRevision?.cue_count, durable.counts.cues);
    assert.ok(durable.cues.every(({ start_ms: start, end_ms: end, text }) => (
      start >= 0 && end > start && text.trim().length > 0
    )), `Gemini persisted invalid cue data: ${JSON.stringify(durable.cues)}`);

    const first = durable.cues[0];
    await seekPreviewTo((Number(first.start_ms) + Number(first.end_ms)) / 2_000);
    await waitForCanvasSubtitleFrame(180_000);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-live-gemini-cues-drawn',
      description: 'The new Gemini method transcribed real media, persisted a valid cue track and drew it through the native preview.',
      details: {
        enrolledCredentialCount: enrollment.enrolled,
        cueCount: durable.counts.cues,
        jobState: job.state,
      },
      focusSelector: '.video-preview .video-container',
    });

    await timeline.click();
    await browser.keys(['\uE009', 'a', '\uE000']);
    await browser.keys(['\uE017']);
    await browser.waitUntil(async () => {
      const current = await surfaceState();
      return current.cues.length === 0 && durableState(root).counts.cues === 0;
    }, {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: 'clearing the new-method result did not produce an empty durable track',
    });

    const beforeOld = durableState(root);
    const priorOldJobs = new Set(
      beforeOld.jobs.filter(({ kind }) => kind === 'transcribe').map(({ id }) => id),
    );
    await clickControl('[data-osg-action="generate-subtitles"]');
    await timeline.click();
    await browser.keys(['\uE009', 'a', '\uE000']);
    const oldMethod = await $('[data-transcription-method="old"]');
    await oldMethod.waitForClickable({ timeout: 60_000 });
    assert.equal(await oldMethod.getAttribute('data-method-available'), 'true');
    await oldMethod.click();
    await clickControl('[data-osg-action="process-subtitles"]');

    let oldSurface = null;
    let oldJob = null;
    let oldDurable = null;
    await browser.waitUntil(async () => {
      oldSurface = await surfaceState();
      oldDurable = durableState(root);
      const jobs = oldDurable.jobs.filter(({ id, kind }) => (
        kind === 'transcribe' && !priorOldJobs.has(id)
      ));
      assert.ok(jobs.length <= 1, `one old-method click created multiple jobs: ${JSON.stringify(jobs)}`);
      [oldJob = null] = jobs;
      if (oldSurface.errorToasts.length > 0 || terminalStates.has(oldJob?.state)) {
        throw new Error(`old Gemini transcription terminated: ${JSON.stringify({ oldJob, oldSurface })}`);
      }
      return oldJob?.state === 'succeeded'
        && oldSurface.processing === false
        && oldSurface.cues.length > 0
        && oldDurable.counts.cues > 0;
    }, {
      timeout: 10 * 60_000,
      interval: 1_000,
      timeoutMsg: 'the old Gemini method never produced a succeeded durable cue track',
    });
    assert.deepEqual(oldSurface.inlineErrors, [], 'the old Gemini method painted an inline error');
    const oldFirst = oldDurable.cues[0];
    await seekPreviewTo((Number(oldFirst.start_ms) + Number(oldFirst.end_ms)) / 2_000);
    await waitForCanvasSubtitleFrame(180_000);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-old-gemini-cues-drawn',
      description: 'The old Gemini method independently produced a succeeded durable cue track and native preview.',
      details: { cueCount: oldDurable.counts.cues, jobState: oldJob.state },
      focusSelector: '.video-preview .video-container',
    });
  });
});
