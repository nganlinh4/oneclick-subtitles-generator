import { copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';

import { createRunRoot, removeRunRoot, runRootAuthorization } from '../support/environment.js';
import { stagedFourWindowAsrVideo } from '../support/fourWindowAsrFixture.js';
import {
  runScenarioAttemptWithEvidence, runScenarioProcesses, withScenarioLeases,
} from '../support/twoProcessScenario.js';

withScenarioLeases(({
  applicationLease, inheritedApplication, managedPaths, publication, stagingLease,
}) => {
  const label = 'Four-window live Gemini transcription';
  const spec = process.argv.includes('--transcribe-live')
    ? './journeys/wordNativeParallelLongRecording.journey.js'
    : './journeys/geminiMultiWindowTranscription.journey.js';
  const root = createRunRoot({ stagingLease });
  const authorization = runRootAuthorization(root);
  try {
    const succeeded = runScenarioAttemptWithEvidence({
      label, publication, root, spec,
      operation: () => {
        const stagedMediaSelection = stagedFourWindowAsrVideo({
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
          phases: ['seed'],
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
    removeRunRoot(root, authorization);
    delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  }
});
