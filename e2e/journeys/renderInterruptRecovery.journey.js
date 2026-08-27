// A desktop process dies while a native render job is running; the next process must tell the
// truth about it. The storage boundary interrupts stale in-flight jobs at boot and reconciles
// pending artifact bytes away, so a customer never sees a phantom in-progress render, a zombie
// job, or partial output presented as finished — and the very next render must succeed.
//
// The seed phase deliberately ends while the job is mid-flight: the scenario supervisor tears the
// application down exactly the way a crash or forced logoff would. Nothing cancels the job first.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl, openEditor } from '../support/editor.js';
import {
  RENDER_BUTTON,
  assertManagedArtifactLedgerMatchesDisk,
  newJobsSince,
  queueSurface,
  setRenderSettings,
} from '../support/renderQueue.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'render-interrupt-recovery';
const PHASE = process.env.OSG_E2E_PERSISTENCE_PHASE;
const TERMINAL_TIMEOUT_MS = 10 * 60 * 1_000;
// States a killed-mid-flight job may honestly hold after recovery. 'running' is a zombie and
// 'succeeded' would mean partial work was promoted; both are defects this journey exists to catch.
const HONEST_INTERRUPTED_STATES = new Set(['interrupted', 'failed', 'cancelled']);

/* global $, browser, describe, it */

const renderJobs = root => durableState(root).jobs.filter(({ kind }) => kind === 'renderVideo');

describe('render interruption and relaunch recovery', () => {
  it('interrupts the killed job honestly and completes the next render', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the harness must have an isolated data root');
    assert.ok(
      PHASE === 'seed' || PHASE === 'verify',
      'run this persistence journey through scenarios/renderInterruptRecovery.mjs',
    );

    if (PHASE === 'verify') {
      // The application booted before this session attached, so recovery has already run.
      const jobs = renderJobs(root);
      assert.equal(jobs.length, 1, `the seed left ${jobs.length} render jobs instead of one`);
      const [interrupted] = jobs;
      assert.ok(HONEST_INTERRUPTED_STATES.has(interrupted.state),
        `the killed render job restored as ${JSON.stringify(interrupted.state)} instead of a terminal interruption`);
      assertManagedArtifactLedgerMatchesDisk(root);

      await openEditor();
      await clickControl('.render-video-toggle');
      await $('.video-rendering-section.expanded').waitForDisplayed({
        timeout: 60_000,
        timeoutMsg: 'the video-rendering section never expanded after relaunch',
      });
      let surface = await queueSurface();
      assert.equal(
        surface.rows.some(({ status }) => status === 'processing' || status === 'pending'),
        false,
        `a fresh process shows a phantom in-flight render: ${JSON.stringify(surface.rows)}`,
      );
      assert.equal(
        surface.rows.some(({ canDownload }) => canDownload),
        false,
        'a fresh process offers partial output from the interrupted render as downloadable',
      );
      assert.equal(surface.renderEnabled, true,
        'the public Render control did not recover after the interruption');
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '02-honest-interrupted-queue',
        description: 'After relaunch the killed render is terminal with no phantom progress or partial download.',
        details: { interrupted: { id: interrupted.id, state: interrupted.state } },
        focusSelector: '.video-rendering-section',
      });

      // Full recovery means the next render is ordinary: admitted, completed, reconciled.
      const priorIds = new Set(renderJobs(root).map(({ id }) => id));
      await clickControl(RENDER_BUTTON);
      let recovered = null;
      await browser.waitUntil(async () => {
        const created = newJobsSince({ jobs: renderJobs(root) }, priorIds);
        assert.ok(created.length <= 1, `one Render click created multiple jobs: ${JSON.stringify(created)}`);
        [recovered = null] = created;
        return recovered !== null
          && ['succeeded', 'failed', 'cancelled'].includes(recovered.state);
      }, {
        timeout: TERMINAL_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: 'the post-recovery render never reached a terminal state',
      });
      assert.equal(recovered.state, 'succeeded',
        `the post-recovery render ended ${JSON.stringify(recovered.state)}`);
      surface = await queueSurface();
      assert.ok(surface.rows.some(({ status, canDownload }) => status === 'completed' && canDownload),
        `no completed downloadable row appeared for the recovered render: ${JSON.stringify(surface.rows)}`);
      assertManagedArtifactLedgerMatchesDisk(root);
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '03-recovered-render-succeeded',
        description: 'The next render after the interruption completes and reconciles exactly.',
        details: { recovered: { id: recovered.id, state: recovered.state } },
        focusSelector: '.video-rendering-section',
      });
      return;
    }

    await openProjectWithMedia();
    await importSubtitles();
    await clickControl('.render-video-toggle');
    await $('.video-rendering-section.expanded').waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'the public video-rendering section never expanded',
    });
    // A 1080p/30 upscale of the real nineteen-second source runs long enough that the process
    // teardown lands mid-render instead of racing a finished job.
    await setRenderSettings({
      root,
      resolution: '1080p',
      resolutionOptionIndex: 3,
      frameRate: 30,
      frameRateOptionIndex: 2,
      frameRatePrefix: '30 FPS',
    });
    const priorIds = new Set(renderJobs(root).map(({ id }) => id));
    await clickControl(RENDER_BUTTON);
    let admitted = null;
    let surface = null;
    await browser.waitUntil(async () => {
      const created = newJobsSince({ jobs: renderJobs(root) }, priorIds);
      assert.ok(created.length <= 1, `one Render click created multiple jobs: ${JSON.stringify(created)}`);
      [admitted = null] = created;
      surface = await queueSurface();
      return admitted?.state === 'running'
        && surface.rows.length === 1
        && surface.rows[0].status === 'processing';
    }, {
      timeout: 120_000,
      interval: 75,
      timeoutMsg: 'the render never became one owned running job with one processing row',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-running-render-before-kill',
      description: 'One native render job is running; the process will now be torn down around it.',
      details: { jobId: admitted.id, state: admitted.state },
      focusSelector: '.video-rendering-section',
    });
    // Leave with the job still running: re-check immediately before returning so the teardown
    // provably lands mid-flight rather than after a quiet completion.
    const finalCheck = renderJobs(root).find(({ id }) => id === admitted.id);
    assert.equal(finalCheck?.state, 'running',
      'the render completed before the seed process could end around it');
  });
});
