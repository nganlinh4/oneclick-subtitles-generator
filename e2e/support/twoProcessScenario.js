import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { createRunRoot, removeRunRoot } from './environment.js';
import { resetWorkflowEvidence, workflowNameForJourney } from './workflowEvidence.js';

/* global console */

const E2E_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WDIO = join(E2E_ROOT, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js');

export const runScenarioProcesses = ({
  label,
  root,
  phases,
  phaseVariable = 'OSG_E2E_PERSISTENCE_PHASE',
  resetEvidence = false,
  spec,
}) => {
  const workflow = workflowNameForJourney(spec);
  if (resetEvidence) resetWorkflowEvidence(workflow);
  const runPhase = (phase) => {
    const environment = {
      ...process.env,
      OSG_E2E_DATA_ROOT: root,
      OSG_E2E_KEEP_ROOT: '1',
      OSG_E2E_WORKFLOW: workflow,
      [phaseVariable]: phase,
    };
    delete environment.OSG_E2E_MEDIA_SELECTION;
    delete environment.OSG_E2E_MEDIA_DESTINATION;

    process.stdout.write(`\n=== ${label} process: ${phase} ===\n`);
    return spawnSync(
      process.execPath,
      [WDIO, 'run', 'wdio.conf.js', '--spec', spec],
      { cwd: E2E_ROOT, env: environment, stdio: 'inherit', windowsHide: true },
    );
  };

  try {
    for (const phase of phases) {
      const result = runPhase(phase);
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${phase} process failed with exit ${result.status}`);
    }
    process.stdout.write(`\n${label} passed across ${phases.length} desktop process(es).\n`);
    return true;
  } catch (error) {
    console.error(`\n${label} failed; evidence retained at ${root}`);
    console.error(error);
    return false;
  }
};

export const runTwoProcessScenario = ({ label, spec }) => {
  const root = createRunRoot();
  const succeeded = runScenarioProcesses({
    label,
    root,
    phases: ['seed', 'verify'],
    resetEvidence: true,
    spec,
  });
  if (succeeded) removeRunRoot(root);
  return succeeded;
};
