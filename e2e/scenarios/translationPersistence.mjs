import process from 'node:process';

import { runTwoProcessScenario } from '../support/twoProcessScenario.js';

if (!runTwoProcessScenario({
  label: 'Translation persistence',
  spec: './journeys/translationPersistence.journey.js',
})) {
  process.exitCode = 1;
}
