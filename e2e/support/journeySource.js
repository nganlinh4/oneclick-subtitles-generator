// Source text of a journey together with its step modules, for contract tests that pin journey
// behaviour. A journey split into e2e/journeys/steps/<journeyBase>/*.js is still one journey.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const JOURNEY_ROOT = join(import.meta.dirname, '..', 'journeys');

/** Step module paths for `<journeyBase>.journey.js`, in a stable order. */
const journeyStepFiles = (journeyFileName) => {
  const base = journeyFileName.replace(/\.journey\.js$/u, '');
  const stepRoot = join(JOURNEY_ROOT, 'steps', base);
  if (!existsSync(stepRoot)) return [];
  return readdirSync(stepRoot)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => join(stepRoot, name));
};

/** The journey file followed by each of its step modules, joined with newlines. */
export const readJourneySource = (journeyFileName) => [
  join(JOURNEY_ROOT, journeyFileName),
  ...journeyStepFiles(journeyFileName),
].map((path) => readFileSync(path, 'utf8')).join('\n');
