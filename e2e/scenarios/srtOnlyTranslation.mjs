import process from 'node:process';
import { runTwoProcessScenario } from '../support/twoProcessScenario.js';

if (!runTwoProcessScenario({
  label: 'SRT-only translation and relaunch',
  spec: './journeys/srtOnlyTranslationDiagnostic.journey.js',
})) process.exitCode = 1;
