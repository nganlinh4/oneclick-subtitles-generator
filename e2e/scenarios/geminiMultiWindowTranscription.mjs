import { copyFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

import { createRunRoot, removeRunRoot, runRootAuthorization } from '../support/environment.js';
import { stagedFourWindowAsrVideo } from '../support/fourWindowAsrFixture.js';
import {
  runScenarioAttemptWithEvidence, runScenarioProcesses, withScenarioLeases,
} from '../support/twoProcessScenario.js';

withScenarioLeases(({
  applicationLease, inheritedApplication, managedPaths, publication, stagingLease,
}) => {
  const label = 'Real customer Gemini Transcribe Live';
  const spec = './journeys/geminiMultiWindowTranscription.journey.js';
  const root = createRunRoot({ stagingLease });
  const authorization = runRootAuthorization(root);
  try {
    const succeeded = runScenarioAttemptWithEvidence({
      label, publication, root, spec,
      operation: () => {
        const mediaArgument = process.argv.indexOf('--media');
        const suppliedMedia = mediaArgument < 0 ? null : resolve(process.argv[mediaArgument + 1] ?? '');
        if (suppliedMedia && !statSync(suppliedMedia).isFile()) throw new Error('--media must name a file');
        const stagedMediaSelection = suppliedMedia ? (() => {
          // Copy into the isolated fixture root; never modify or activate the user's live project.
          const staged = join(root, 'input', 'customer-reproduction.mp4');
          copyFileSync(suppliedMedia, staged);
          return staged;
        })() : stagedFourWindowAsrVideo({
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
