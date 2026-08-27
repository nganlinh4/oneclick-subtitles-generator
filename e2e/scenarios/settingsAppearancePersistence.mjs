import process from 'node:process';

import { runTwoProcessScenario } from '../support/twoProcessScenario.js';

if (!runTwoProcessScenario({
  label: 'Appearance preference persistence',
  spec: './journeys/settingsAppearancePersistence.journey.js',
})) {
  process.exitCode = 1;
}
