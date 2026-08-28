import process from 'node:process';

import {
  createRunRoot, removeRunRoot, runRootAuthorization,
} from '../support/environment.js';
import { runScenarioProcesses, withScenarioLeases } from '../support/twoProcessScenario.js';
import {
  finalizeWorkflowEvidence, workflowNameForJourney,
} from '../support/workflowEvidence.js';

/* global console */

// A private, disposable native-tools store (keepNativeTools: false) is what makes a REAL delete
// safe here: this run's `data/native-tools` is not the persistent cache other journeys junction in
// and reuse, so installing one small tool and permanently removing it again cannot force any other
// journey to re-download it.
withScenarioLeases(({ inheritedApplication, managedPaths, stagingLease }) => {
  const spec = './journeys/settingsToolsRemoveAndFactoryReset.journey.js';
  const workflow = workflowNameForJourney(spec);
  const root = createRunRoot({ keepNativeTools: false, keepEnginePackages: true, stagingLease });
  const rootAuthorization = runRootAuthorization(root);
  let succeeded = false;
  let failure = null;
  try {
    succeeded = runScenarioProcesses({
      label: 'Tool removal deletes exactly the managed tree; factory reset clears a real credential',
      root,
      phases: ['run'],
      phaseVariable: 'OSG_E2E_TOOLS_RESET_PHASE',
      resetEvidence: true,
      spec,
      inheritedApplication,
      managedPaths,
    });
    if (!succeeded) throw new Error('the tool-removal / factory-reset process failed');
    process.stdout.write('\nTools removal and factory reset passed: exact deletion, cleared credential, isolated store untouched otherwise.\n');
  } catch (error) {
    failure = error;
    console.error(`\nTools removal / factory reset scenario failed; evidence retained at ${root}`);
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
        console.error('\nTools removal / factory reset evidence finalization failed.');
        console.error(error);
        process.exitCode = 1;
      }
    }
    delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    removeRunRoot(root, rootAuthorization);
  }
});
