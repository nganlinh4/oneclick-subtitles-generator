import process from 'node:process';
import { runTwoProcessScenario } from '../support/twoProcessScenario.js';

if (!runTwoProcessScenario({
  label: 'History cursor across restart',
  spec: './journeys/historyAcrossRestart.journey.js',
})) process.exitCode = 1;
