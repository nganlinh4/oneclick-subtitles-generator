import { copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';

import {
  createRunRoot, REPOSITORY_ROOT, removeRunRoot, runRootAuthorization,
} from '../support/environment.js';
import { ensureRealVideo } from '../support/realMedia.js';
import {
  runScenarioAttemptWithEvidence, runScenarioProcesses, withScenarioLeases,
} from '../support/twoProcessScenario.js';

withScenarioLeases(({
  applicationLease, inheritedApplication, managedPaths, publication, stagingLease,
}) => {
  const label = 'Live Gemini background image persistence';
  const spec = './journeys/geminiBackgroundImageSuccess.journey.js';
  const root = createRunRoot({ stagingLease });
  const authorization = runRootAuthorization(root);
  try {
    const succeeded = runScenarioAttemptWithEvidence({
      label, publication, root, spec,
      operation: () => {
        const stage = (source, prefix = '') => {
          const destination = join(root, 'input', `${prefix}${basename(source)}`);
          copyFileSync(source, destination);
          return destination;
        };
        const video = stage(ensureRealVideo({ applicationLease }));
        const reference = stage(join(REPOSITORY_ROOT, 'apps', 'desktop', 'src-tauri', 'icons', '128x128.png'), 'reference-');
        return runScenarioProcesses({
          label,
          root,
          phases: ['seed', 'verify'],
          spec,
          stagedMediaSelectionSequence: [video, reference],
          inheritedApplication,
          managedPaths,
          publication,
        });
      },
    });
    if (!succeeded) process.exitCode = 1;
  } finally {
    removeRunRoot(root, authorization);
    delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  }
});
