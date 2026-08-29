import { copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';

import {
  createRunRoot, removeRunRoot, runRootAuthorization,
} from '../support/environment.js';
import { stagedLongSyntheticMedia } from '../support/longSyntheticMediaFixture.js';
import {
  runScenarioAttemptWithEvidence, runScenarioProcesses, withScenarioLeases,
} from '../support/twoProcessScenario.js';

withScenarioLeases(({
  applicationLease, inheritedApplication, managedPaths, publication, stagingLease,
}) => {
  const label = 'Long-media waveform interruption and relaunch recovery';
  const spec = './journeys/longMediaOperationRecovery.journey.js';
  const root = createRunRoot({ stagingLease });
  const rootAuthorization = runRootAuthorization(root);
  try {
    const succeeded = runScenarioAttemptWithEvidence({
      label, publication, root, spec,
      operation: () => {
        const stagedMediaSelection = stagedLongSyntheticMedia({
          applicationLease,
          stage: (source) => {
            const staged = join(root, 'input', basename(source));
            copyFileSync(source, staged);
            return staged;
          },
        });
        return runScenarioProcesses({
          label,
          root,
          phases: ['seed', 'verify'],
          spec,
          stagedMediaSelection,
          inheritedApplication,
          managedPaths,
          publication,
        });
      },
    });
    if (!succeeded) process.exitCode = 1;
  } finally {
    removeRunRoot(root, rootAuthorization);
    delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  }
});
