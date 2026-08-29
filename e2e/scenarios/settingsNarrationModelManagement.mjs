import process from 'node:process';

import {
  createRunRoot, removeRunRoot, runRootAuthorization,
} from '../support/environment.js';
import { runScenarioProcesses, withScenarioLeases } from '../support/twoProcessScenario.js';
import {
  finalizeWorkflowEvidence, workflowNameForJourney,
} from '../support/workflowEvidence.js';

/* global console */

// Mirrors nativeToolsInstall.mjs's from-empty pattern, but for the SPEECH package store: the
// journey's honesty claim (an empty profile truthfully reports "not installed", and cancelling a
// real install leaves no orphaned bytes) only holds if the engine-packages cache is genuinely
// disposable for this run, not the persistent, shared cache other journeys reuse across runs.
withScenarioLeases(({ inheritedApplication, managedPaths, publication, stagingLease }) => {
  const spec = './journeys/settingsNarrationModelManagement.journey.js';
  const workflow = workflowNameForJourney(spec);
  const root = createRunRoot({ keepNativeTools: true, keepEnginePackages: false, stagingLease });
  const rootAuthorization = runRootAuthorization(root);
  let succeeded = false;
  let failure = null;
  try {
    succeeded = runScenarioProcesses({
      label: 'Narration model package: truthful status + clean install cancellation',
      root,
      phases: ['manage'],
      phaseVariable: 'OSG_E2E_MODEL_MANAGEMENT_PHASE',
      resetEvidence: true,
      spec,
      inheritedApplication,
      managedPaths,
      publication,
    });
    if (!succeeded) throw new Error('the narration model management process failed');
    process.stdout.write('\nNarration model management passed: truthful not-installed status, real install start, clean cancellation.\n');
  } catch (error) {
    failure = error;
    console.error('\nNarration model management scenario failed; inspect its durable workflow evidence before retrying');
    console.error(error);
    process.exitCode = 1;
  } finally {
    const attemptId = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    if (attemptId !== undefined) {
      try {
        finalizeWorkflowEvidence({
          workflow,
          attemptId,
          outcome: succeeded ? 'pass' : 'fail',
          exitStatus: succeeded ? 0 : 1,
          failure: failure?.message ?? null,
        });
      } catch (error) {
        console.error('\nNarration model management evidence finalization failed.');
        console.error(error);
        process.exitCode = 1;
      }
    }
    delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    removeRunRoot(root, rootAuthorization);
  }
});
