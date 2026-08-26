import { copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';

import {
  createRunRoot, removeRunRoot, runRootAuthorization,
} from '../support/environment.js';
import { stagedFourWindowAsrVideo } from '../support/fourWindowAsrFixture.js';
import { runScenarioProcesses, withScenarioLeases } from '../support/twoProcessScenario.js';
import {
  finalizeWorkflowEvidence, resetWorkflowEvidence, workflowNameForJourney,
} from '../support/workflowEvidence.js';

withScenarioLeases(({ inheritedApplication, managedPaths, stagingLease }) => {
  const label = 'Four-window local ASR persistence';
  const spec = './journeys/multiWindowAsrPersistence.journey.js';
  const workflow = workflowNameForJourney(spec);
  const root = createRunRoot({ stagingLease });
  const rootAuthorization = runRootAuthorization(root);
  const attemptDirectory = resetWorkflowEvidence(workflow);
  const attemptId = attemptDirectory.split(/[\\/]/u).at(-1);
  // The scenario's own live application lease already covers the asset lane; the fixture helper
  // must not acquire a second time against it.
  const stagedMediaSelection = stagedFourWindowAsrVideo({
    inheritedApplication,
    stage: (source) => {
      const staged = join(root, 'input', basename(source));
      copyFileSync(source, staged);
      return staged;
    },
  });
  let succeeded = false;
  try {
    succeeded = runScenarioProcesses({
      label,
      root,
      phases: ['seed', 'verify'],
      spec,
      stagedMediaSelection,
      inheritedApplication,
      managedPaths,
    });
    finalizeWorkflowEvidence({
      workflow,
      attemptId,
      outcome: succeeded ? 'pass' : 'fail',
      exitStatus: succeeded ? 0 : 1,
      failure: succeeded ? null : `${label} did not complete both hidden desktop processes`,
    });
    if (!succeeded) process.exitCode = 1;
  } finally {
    removeRunRoot(root, rootAuthorization);
    delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  }
});
