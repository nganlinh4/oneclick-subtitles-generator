import process from 'node:process';

import { runTwoProcessScenario } from '../support/twoProcessScenario.js';

const repeatIndex = process.argv.indexOf('--repeat');
const repeat = repeatIndex < 0 ? 1 : Number(process.argv[repeatIndex + 1]);
if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 100) {
  throw new Error('--repeat must be an integer from 1 through 100');
}
for (let iteration = 1; iteration <= repeat; iteration += 1) {
  if (!runTwoProcessScenario({
    label: `Word-native real customer vertical slice (${iteration}/${repeat})`,
    spec: './journeys/wordNativeVerticalSlice.journey.js',
  })) {
    process.exitCode = 1;
  }
}
