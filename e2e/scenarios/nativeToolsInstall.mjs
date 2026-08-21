import process from 'node:process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRunRoot, removeRunRoot } from '../support/environment.js';
import { tamperInstalledTool } from '../support/nativeToolsOracle.js';
import { runScenarioProcesses } from '../support/twoProcessScenario.js';

/* global console */

const root = createRunRoot({ keepNativeTools: false });
let succeeded = false;
try {
  const installed = runScenarioProcesses({
    label: 'Native tools from-empty install',
    root,
    phases: ['install'],
    phaseVariable: 'OSG_E2E_NATIVE_TOOLS_PHASE',
    resetEvidence: true,
    spec: './journeys/nativeToolsInstall.journey.js',
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
    spec: './journeys/nativeToolsInstall.journey.js',
  });
  if (!repaired) throw new Error('the repair process failed');
  succeeded = true;
  process.stdout.write('\nNative tools passed clean install, independent digest proof, tamper detection, and repair.\n');
} catch (error) {
  console.error(`\nNative-tools scenario failed; evidence retained at ${root}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (succeeded) removeRunRoot(root);
}
