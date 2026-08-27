import process from 'node:process';

import { runTwoProcessScenario } from '../support/twoProcessScenario.js';

if (!runTwoProcessScenario({
  label: 'Render interruption recovery',
  spec: './journeys/renderInterruptRecovery.journey.js',
})) {
  process.exitCode = 1;
}
