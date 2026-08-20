import { readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const E2E_ROOT = import.meta.dirname;
const JOURNEY_ROOT = join(E2E_ROOT, 'journeys');
const WDIO = join(E2E_ROOT, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js');
const CONFIG = join(E2E_ROOT, 'wdio.conf.js');

// These are intentionally not part of the ordinary product suite. The damaged-font journey needs a
// staged application assembled by its scenario runner; the other two are diagnostic probes whose
// output is useful only while narrowing a known failure.
const NON_DEFAULT_JOURNEYS = new Set([
  'damagedFontPayload.journey.js',
  'reconnaissance.journey.js',
  'restoreProbe.journey.js',
]);

const fail = (message) => {
  throw new Error(`isolated E2E runner: ${message}`);
};

export const defaultJourneys = () => readdirSync(JOURNEY_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.journey.js'))
  .map((entry) => entry.name)
  .filter((name) => !NON_DEFAULT_JOURNEYS.has(name))
  .sort()
  .map((name) => join(JOURNEY_ROOT, name));

export const normalizeJourney = (input) => {
  const candidate = resolve(E2E_ROOT, input);
  const inside = relative(JOURNEY_ROOT, candidate);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || inside.includes(sep)) {
    fail(`journey must be one file directly under ${JOURNEY_ROOT}`);
  }
  if (!candidate.endsWith('.journey.js') || !statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
    fail(`journey does not exist: ${input}`);
  }
  return candidate;
};

export const parseArguments = (arguments_) => {
  let repeat = 1;
  const journeys = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--repeat') {
      const raw = arguments_[index + 1];
      index += 1;
      repeat = Number(raw);
      if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 100) {
        fail('--repeat must be an integer from 1 through 100');
      }
      continue;
    }
    if (argument.startsWith('-')) fail(`unknown option: ${argument}`);
    journeys.push(normalizeJourney(argument));
  }
  return { repeat, journeys: journeys.length === 0 ? defaultJourneys() : [...new Set(journeys)] };
};

export const isolatedEnvironment = (environment) => {
  const clean = { ...environment };
  // `wdio.conf.js` creates the root while loading in each fresh child. Carrying any of these values
  // from the parent would deliberately defeat that isolation or reuse a dialog answer from another
  // journey.
  for (const key of [
    'OSG_E2E_DATA_ROOT',
    'OSG_E2E_KEEP_ROOT',
    'OSG_E2E_MEDIA_SELECTION',
    'OSG_E2E_MEDIA_DESTINATION',
    'WEBVIEW2_USER_DATA_FOLDER',
  ]) {
    delete clean[key];
  }
  return clean;
};

const run = ({ repeat, journeys }) => {
  const failures = [];
  const started = Date.now();
  for (let iteration = 1; iteration <= repeat; iteration += 1) {
    for (const journey of journeys) {
      const label = `${basename(journey)} (${iteration}/${repeat})`;
      process.stdout.write(`\n=== isolated journey: ${label} ===\n`);
      const result = spawnSync(
        process.execPath,
        [WDIO, 'run', CONFIG, '--spec', journey],
        {
          cwd: E2E_ROOT,
          env: isolatedEnvironment(process.env),
          stdio: 'inherit',
          windowsHide: true,
        },
      );
      if (result.error) fail(`${label} could not start: ${result.error.message}`);
      if (result.status !== 0) failures.push({ label, status: result.status });
    }
  }
  const seconds = ((Date.now() - started) / 1_000).toFixed(1);
  process.stdout.write(
    `\n=== isolated journey summary: ${journeys.length * repeat - failures.length} passed, `
    + `${failures.length} failed, ${seconds}s ===\n`,
  );
  for (const failure of failures) process.stdout.write(`FAILED ${failure.label}: ${failure.status}\n`);
  if (failures.length > 0) process.exitCode = 1;
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  run(parseArguments(process.argv.slice(2)));
}
