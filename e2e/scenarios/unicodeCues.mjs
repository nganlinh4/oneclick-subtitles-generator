import process from 'node:process';

import { runTwoProcessScenario } from '../support/twoProcessScenario.js';

if (!runTwoProcessScenario({
  label: 'Unicode cue persistence',
  spec: './journeys/unicodeCues.journey.js',
})) {
  process.exitCode = 1;
}
