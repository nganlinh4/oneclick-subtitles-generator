import process from 'node:process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createRunRoot, removeRunRoot, runRootAuthorization,
} from '../support/environment.js';
import { tamperInstalledTool } from '../support/nativeToolsOracle.js';
import { runScenarioProcesses, withScenarioLeases } from '../support/twoProcessScenario.js';
import {
  finalizeWorkflowEvidence, workflowNameForJourney,
} from '../support/workflowEvidence.js';

/* global console */

withScenarioLeases(({ inheritedApplication, managedPaths, stagingLease }) => {
  const spec = './journeys/nativeToolsInstall.journey.js';
  const workflow = workflowNameForJourney(spec);
  const root = createRunRoot({ keepNativeTools: false, stagingLease });
  const rootAuthorization = runRootAuthorization(root);
  let succeeded = false;
  let failure = null;
  try {
    const installed = runScenarioProcesses({
      label: 'Native tools from-empty install',
      root,
      phases: ['install'],
      phaseVariable: 'OSG_E2E_NATIVE_TOOLS_PHASE',
      resetEvidence: true,
      spec,
      inheritedApplication,
      managedPaths,
    });
    if (!installed) throw new Error('the from-empty install process failed');

    const proof = JSON.parse(readFileSync(
      join(root, 'evidence', 'native-tools-installed.json'), 'utf8',
    ));
    const tamper = tamperInstalledTool(root, proof);
    process.stdout.write(`\nSame-size tamper staged inside disposable root: ${JSON.stringify(tamper)}\n`);

    const repaired = runScenarioProcesses({
      label: 'Native tools tamper repair',
      root,
      phases: ['repair'],
      phaseVariable: 'OSG_E2E_NATIVE_TOOLS_PHASE',
      spec,
      inheritedApplication,
      managedPaths,
    });
    if (!repaired) throw new Error('the repair process failed');
    succeeded = true;
    process.stdout.write('\nNative tools passed clean install, independent digest proof, tamper detection, and repair.\n');
  } catch (error) {
    failure = error;
    console.error(`\nNative-tools scenario failed; evidence retained at ${root}`);
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
        console.error('\nNative-tools evidence finalization failed.');
        console.error(error);
        process.exitCode = 1;
      }
    }
    delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    removeRunRoot(root, rootAuthorization);
  }
});
