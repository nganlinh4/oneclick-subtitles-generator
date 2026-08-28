// A desktop process dies while a native waveform-generation job for a two-hour synthetic source is
// running; the next process must tell the truth about it. The boot-time job/artifact reconciliation
// this relies on is kind-agnostic -- crates/osg-infrastructure/src/storage/jobs.rs interrupts every
// stale 'running'/'cancelling' job regardless of kind, and
// crates/osg-infrastructure/src/storage/artifacts.rs's reconcile() walks every artifact the same
// way -- so the SAME honesty guarantee renderInterruptRecovery.journey.js proves for a killed render
// job applies here to a killed generateWaveform job. Long media matters for this specific proof: it
// is what makes the seed phase's "job still running when the process is torn down" observation
// non-racy without depending on unmeasured native decode throughput (see
// support/longSyntheticMediaFixture.js's two-hour margin).
//
// The seed phase deliberately ends while the job is mid-flight: the scenario supervisor tears the
// application down exactly the way a crash or forced logoff would. Nothing cancels the job first.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { openEditor } from '../support/editor.js';
import { assertManagedArtifactLedgerMatchesDisk } from '../support/renderQueue.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'long-media-operation-recovery';
const PHASE = process.env.OSG_E2E_PERSISTENCE_PHASE;
// States a killed-mid-flight job may honestly hold after recovery. 'running'/'cancelling' is a
// zombie and 'succeeded' would mean partial work was promoted; both are defects this journey exists
// to catch.
const HONEST_INTERRUPTED_STATES = new Set(['interrupted', 'failed', 'cancelled']);

/* global browser, describe, document, it */

const waveformJobs = (root) => durableState(root).jobs.filter(({ kind }) => kind === 'generateWaveform');

const waveformState = () => browser.execute(() => (
  document.querySelector('[data-osg-waveform-state]')?.getAttribute('data-osg-waveform-state') ?? null
));

/**
 * `waitUntil`'s own `timeoutMsg` must be a static string -- the options object is evaluated eagerly
 * at call time, before the predicate ever runs. A diagnostic that needs LIVE state read at the
 * moment of failure goes through this wrapper instead, matching timelineBoundary.journey.js's own
 * helper of the same name.
 */
async function waitUntilWithFreshDiagnostic(predicate, { diagnostic, ...options }) {
  try {
    return await browser.waitUntil(predicate, {
      ...options,
      timeoutMsg: 'condition did not settle before its timeout',
    });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
}

describe('long-media waveform interruption and relaunch recovery', () => {
  it('interrupts the killed waveform job honestly and completes it after relaunch', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the harness must have an isolated data root');
    assert.ok(
      PHASE === 'seed' || PHASE === 'verify',
      'run this persistence journey through scenarios/longMediaOperationRecovery.mjs',
    );

    if (PHASE === 'verify') {
      // The application booted before this session attached, so recovery has already run.
      const jobs = waveformJobs(root);
      assert.equal(jobs.length, 1, `the seed left ${jobs.length} waveform jobs instead of one`);
      const [interrupted] = jobs;
      assert.ok(HONEST_INTERRUPTED_STATES.has(interrupted.state),
        `the killed waveform job restored as ${JSON.stringify(interrupted.state)} instead of a terminal interruption`);
      assertManagedArtifactLedgerMatchesDisk(root);
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '02-honest-interrupted-waveform-job',
        description: 'After relaunch the killed waveform job is terminal with no phantom progress and no partial cache artifact.',
        details: { interrupted: { id: interrupted.id, state: interrupted.state } },
        focusSelector: '.timeline-container',
      });

      // Full recovery means the media's waveform is ordinary from here: the session restores the
      // same project/media (matching editPersistRelaunch's own openEditor()-only verify phase) and
      // the product's own effect re-requests and completes a fresh waveform for it.
      await openEditor();
      await waitUntilWithFreshDiagnostic(async () => (await waveformState()) === 'ready', {
        timeout: 300_000,
        interval: 250,
        diagnostic: () => `the long-media waveform never recovered to completion after relaunch: ${JSON.stringify(waveformJobs(root))}`,
      });
      const succeeded = waveformJobs(root)
        .filter(({ id }) => id !== interrupted.id)
        .find(({ state }) => state === 'succeeded');
      assert.ok(succeeded, `no succeeded waveform job followed relaunch recovery: ${JSON.stringify(waveformJobs(root))}`);
      assertManagedArtifactLedgerMatchesDisk(root);
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '03-recovered-waveform-succeeded',
        description: 'The next waveform generation for the same long media after the interruption completes and reconciles exactly.',
        details: { recovered: { id: succeeded.id, state: succeeded.state } },
        focusSelector: '.timeline-container',
      });
      return;
    }

    await openProjectWithMedia();
    await browser.waitUntil(async () => (await waveformState()) === 'processing', {
      timeout: 15_000,
      interval: 20,
      timeoutMsg: (
        'the long-media waveform job never reached "processing" during the seed phase -- either '
        + 'native decode of two hours of audio completed faster than this harness could observe it, '
        + 'or waveform generation never started at all'
      ),
    });
    const jobs = waveformJobs(root);
    assert.ok(jobs.length >= 1, `the seed phase created no waveform job: ${JSON.stringify(jobs)}`);
    const admitted = jobs.at(-1);
    assert.equal(admitted.state, 'running', `the newest waveform job was not running when the seed phase captured it: ${JSON.stringify(admitted)}`);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-running-waveform-before-kill',
      description: 'One native waveform-generation job is running on the two-hour source; the process will now be torn down around it.',
      details: { jobId: admitted.id, state: admitted.state },
      focusSelector: '.timeline-container',
    });
    // Leave with the job still running: re-check immediately before returning so the teardown
    // provably lands mid-flight rather than after a quiet completion.
    const finalCheck = waveformJobs(root).find(({ id }) => id === admitted.id);
    assert.equal(finalCheck?.state, 'running',
      'the waveform job completed before the seed process could end around it');
  });
});
