import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { openProjectWithMedia, selectStagedMediaFile } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'word-native-cancel-retry-switch';

/* global $, $$, browser, describe, document, it */

describe('Customer Journey 6: Cancel, restart, and project switching without leaks', () => {
  it('cancels mid-transcription cleanly, restarts full range, and switches projects without leaks', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'requires an isolated data root');

    // === Step 1: Open project A with long real media (150s) and enroll credentials ===
    await openProjectWithMedia();
    await enrollGeminiCredentials({ limit: 2 });

    const initialDurable = durableState(root);
    assert.equal(initialDurable.counts.projects, 1, 'Project A must exist');
    const projectAId = initialDurable.projects[0].id;
    const mediaAId = initialDurable.media[0].id;

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-project-started',
      description: 'Project A started with long media loaded and credentials enrolled.',
      details: { projectId: projectAId, mediaId: mediaAId },
    });

    // === Step 2: Explicitly select Speech task and Gemini Transcribe engine ===
    await clickControl('[data-osg-action="generate-subtitles"]');
    const modal = await $('.create-subtitles-modal, .video-processing-modal');
    await modal.waitForDisplayed({ timeout: 30_000 });

    const speechTab = await $('[data-task-tab="speech"]');
    if (await speechTab.isDisplayed()) await speechTab.click();

    const engineSelect = await $('#speech-engine-select');
    await engineSelect.waitForDisplayed({ timeout: 10_000 });
    await engineSelect.selectByAttribute('value', 'gemini-3.5-transcribe');

    // Configure 30s window duration to avoid 120s inline audio timeouts
    const accordion = await $('[data-osg-action="speech-advanced-options-toggle"], .creation-accordion-trigger');
    if (await accordion.isDisplayed()) {
      await accordion.click();
    }
    const slider = await $('[data-osg-action="speech-window-duration-slider"], .speech-window-duration-slider');
    await slider.waitForDisplayed({ timeout: 10_000 });
    await browser.execute((val) => {
      const el = document.querySelector('[data-osg-action="speech-window-duration-slider"], .speech-window-duration-slider');
      if (el) {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, 30);

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-transcribe-selected',
      description: 'Speech task and Gemini Transcribe word-native engine explicitly selected.',
    });

    // === Step 3: Start transcription and observe active native job ===
    await clickControl('[data-osg-action="process-subtitles"]');

    let activeJob = null;
    await browser.waitUntil(async () => {
      const state = durableState(root);
      activeJob = state.jobs.find((j) => j.kind === 'transcribe' && j.state === 'running') ?? null;
      return activeJob !== null;
    }, {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: 'Native transcription job never entered running state',
    });
    assert.ok(activeJob?.id, 'Active native job must have an identity');

    // Wait for the stop/cancel button to be clickable
    const cancelBtn = await $('[data-osg-action="cancel-generation"]');
    await cancelBtn.waitForClickable({ timeout: 10_000 });

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-active-job-observed',
      description: 'Active native job observed running with identity before cancellation.',
      details: { jobId: activeJob.id, jobState: activeJob.state },
    });

    // === Step 4: Click the actual Stop control ===
    await clickControl('[data-osg-action="cancel-generation"]');

    // === Step 5: Require terminal cancelled state and no red error toast ===
    let cancelledJob = null;
    await browser.waitUntil(async () => {
      const state = durableState(root);
      cancelledJob = state.jobs.find((j) => j.id === activeJob.id);
      return cancelledJob?.state === 'cancelled';
    }, {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `Job ${activeJob.id} did not reach terminal cancelled state`,
    });
    assert.equal(cancelledJob.state, 'cancelled', 'Job must settle in cancelled state');

    // Assert: No red error toast
    const errorToasts = await $$('.toast-error');
    assert.equal(errorToasts.length, 0, 'Clean cancellation must not display red error toast');

    // Bounded observation period: assert no cues promoted from cancelled operation
    await browser.pause(3_000);
    const postCancelDurable = durableState(root);
    assert.equal(postCancelDurable.counts.cues, 0, 'No cues should be promoted from cancelled operation');

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-cancelled-cleanly',
      description: 'Transcription cancelled cleanly to terminal state without error toasts or leaked cues.',
      details: { jobId: cancelledJob.id, jobState: cancelledJob.state, cuesCount: postCancelDurable.counts.cues },
    });

    // === Step 6: Supported restart action on full range ===
    await clickControl('[data-osg-action="generate-subtitles"]');
    const modalRestart = await $('.create-subtitles-modal, .video-processing-modal');
    await modalRestart.waitForDisplayed({ timeout: 15_000 });

    const speechTabRestart = await $('[data-task-tab="speech"]');
    if (await speechTabRestart.isDisplayed()) await speechTabRestart.click();

    const engineSelectRestart = await $('#speech-engine-select');
    await engineSelectRestart.waitForDisplayed({ timeout: 10_000 });
    await engineSelectRestart.selectByAttribute('value', 'gemini-3.5-transcribe');

    const accordionRestart = await $('[data-osg-action="speech-advanced-options-toggle"], .creation-accordion-trigger');
    if (await accordionRestart.isDisplayed()) {
      await accordionRestart.click();
    }
    const sliderRestart = await $('[data-osg-action="speech-window-duration-slider"], .speech-window-duration-slider');
    await sliderRestart.waitForDisplayed({ timeout: 10_000 });
    await browser.execute((val) => {
      const el = document.querySelector('[data-osg-action="speech-window-duration-slider"], .speech-window-duration-slider');
      if (el) {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, 30);

    await clickControl('[data-osg-action="process-subtitles"]');

    let restartedJob = null;
    let pollCount = 0;
    await browser.waitUntil(async () => {
      const state = durableState(root);
      pollCount += 1;
      if (pollCount % 10 === 1) {
        process.stdout.write(
          `\n[STEP 6 POLL ${pollCount}] cues: ${state.counts.cues}, jobs: ${JSON.stringify(state.jobs.map((j) => ({ id: j.id, kind: j.kind, state: j.state })))}\n`,
        );
      }
      restartedJob = state.jobs.find(
        (j) => j.kind === 'transcribe' && j.id !== activeJob.id && j.state === 'succeeded',
      );
      return restartedJob !== null && state.counts.cues > 0;
    }, {
      timeout: 420_000,
      interval: 1_000,
      timeoutMsg: () => {
        const state = durableState(root);
        return `Restarted transcription never reached succeeded state with captions. Jobs: ${JSON.stringify(state.jobs)}`;
      },
    });

    const restartedDurable = durableState(root);
    assert.ok(restartedDurable.counts.cues > 0, 'Restarted transcription must persist captions');
    assert.equal(restartedJob.state, 'succeeded');

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-restart-completed',
      description: 'Restarted full-range transcription completed with durable captions persisted.',
      details: { jobId: restartedJob.id, cuesCount: restartedDurable.counts.cues },
    });

    // === Step 7: Active A -> Project B isolation ===
    // Modal automatically closed on completion; reopen to start a new job on project A
    await clickControl('[data-osg-action="generate-subtitles"]');
    const modalSecond = await $('.create-subtitles-modal, .video-processing-modal');
    await modalSecond.waitForDisplayed({ timeout: 15_000 });

    const speechTabSecond = await $('[data-task-tab="speech"]');
    if (await speechTabSecond.isDisplayed()) await speechTabSecond.click();

    const engineSelectSecond = await $('#speech-engine-select');
    await engineSelectSecond.waitForDisplayed({ timeout: 10_000 });
    await engineSelectSecond.selectByAttribute('value', 'gemini-3.5-transcribe');

    const accordionSecond = await $('[data-osg-action="speech-advanced-options-toggle"], .creation-accordion-trigger');
    if (await accordionSecond.isDisplayed()) {
      await accordionSecond.click();
    }
    const sliderSecond = await $('[data-osg-action="speech-window-duration-slider"], .speech-window-duration-slider');
    await sliderSecond.waitForDisplayed({ timeout: 10_000 });
    await browser.execute((val) => {
      const el = document.querySelector('[data-osg-action="speech-window-duration-slider"], .speech-window-duration-slider');
      if (el) {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, 30);

    await clickControl('[data-osg-action="process-subtitles"]');

    let secondActiveJob = null;
    await browser.waitUntil(async () => {
      const state = durableState(root);
      secondActiveJob = state.jobs.find(
        (j) => j.kind === 'transcribe' && j.id !== activeJob.id && j.id !== restartedJob.id && j.state === 'running',
      ) ?? null;
      return secondActiveJob !== null;
    }, {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: () => {
        const state = durableState(root);
        return `Second transcription on project A never entered running state. Jobs: ${JSON.stringify(state.jobs)}`;
      },
    });

    // While operation on Project A is active, switch to media/project B through normal controls
    await selectStagedMediaFile();

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '06-project-b-switched',
      description: 'Switched to distinct media/project B via normal upload controls while A was active.',
    });

    // Wait until in-flight work from Project A settles (no running transcribe jobs)
    await browser.waitUntil(async () => {
      const state = durableState(root);
      const runningTranscribe = state.jobs.filter((j) => j.kind === 'transcribe' && j.state === 'running');
      return runningTranscribe.length === 0;
    }, {
      timeout: 60_000,
      interval: 1_000,
      timeoutMsg: 'Project A operations did not settle after switching to project B',
    });

    // Verify Project B isolation
    const settledDurable = durableState(root);
    assert.ok(settledDurable.counts.projects >= 2, 'Project B must be created in SQLite');
    const projectB = settledDurable.projects.at(-1);
    assert.notEqual(projectB.id, projectAId, 'Project B must have distinct project identity from A');

    // Verify Project B's media is distinct from Media A
    const mediaB = settledDurable.media.at(-1);
    assert.notEqual(mediaB.id, mediaAId, 'Project B must own distinct media asset');

    // Check UI for Project B: cues in Project B are empty (zero leaked from A)
    const visibleCuesProjectB = await browser.execute(() => (
      [...document.querySelectorAll('.lyric-text')]
        .map((n) => (n.innerText || '').trim()).filter(Boolean)
    ));
    assert.equal(
      visibleCuesProjectB.length,
      0,
      `Project B must not have any leaked cues from Project A: ${JSON.stringify(visibleCuesProjectB)}`,
    );

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '07-project-b-isolated',
      description: 'Project B retains its own media identity and has zero leaked cues from Project A.',
      details: {
        projectAId,
        projectBId: projectB.id,
        mediaAId,
        mediaBId: mediaB.id,
        projectBVisibleCues: visibleCuesProjectB.length,
      },
    });
  });
});

