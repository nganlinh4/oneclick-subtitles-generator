import { readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import { scrubAutomationEnvironment } from './support/automationEnvironment.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runSupervisedSync } = require('../scripts/windows-job-supervisor.js');

const E2E_ROOT = import.meta.dirname;
const JOURNEY_ROOT = join(E2E_ROOT, 'journeys');
const WDIO = join(E2E_ROOT, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js');
const CONFIG = join(E2E_ROOT, 'wdio.conf.js');

// These are intentionally not part of the ordinary product suite. The damaged-font journey needs a
// staged application assembled by its scenario runner; the other two are diagnostic probes whose
// output is useful only while narrowing a known failure. transcriptionRulesAndAnalysis runs the
// reviewed local ASR engine to full completion TWICE end to end (once per compared segmentation
// setting) in one process -- like nativeToolsInstall, it is a real single-process journey a
// developer can still run directly by name, just not on every ordinary pass.
// longMediaResourceBounds joins that same single-process heavy group: it decodes real PCM
// proportional to a two-hour synthetic source (twice) and drives a real zoom/seek/playback session
// (own script: test:long-media-resource-bounds). longMediaOperationRecovery is a two-process
// PHASE-gated scenario like renderInterruptRecovery, needing scenarios/longMediaOperationRecovery.mjs.
const NON_DEFAULT_JOURNEYS = new Set([
  'damagedFontPayload.journey.js',
  'editPersistRelaunch.journey.js',
  'longMediaOperationRecovery.journey.js',
  'longMediaResourceBounds.journey.js',
  'multiWindowAsrPersistence.journey.js',
  'nativeToolsInstall.journey.js',
  'reconnaissance.journey.js',
  'renderInterruptRecovery.journey.js',
  'settingsAppearancePersistence.journey.js',
  'settingsNarrationModelManagement.journey.js',
  'settingsToolsRemoveAndFactoryReset.journey.js',
  'transcriptionRulesAndAnalysis.journey.js',
  'translationPersistence.journey.js',
  'unicodeCues.journey.js',
]);

const fail = (message) => {
  throw new Error(`isolated E2E runner: ${message}`);
};

const samePath = (left, right) => (
  process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
);

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
  // `wdio.conf.js` creates the root while loading in each fresh child. Carrying any automation or
  // WebView capability from the parent would defeat isolation or reuse another run's driver token.
  return scrubAutomationEnvironment(environment);
};

const loadLaunchRuntime = async () => {
  const [
    environment, applicationLease, cacheMaintenance, evidenceLease, stagingLease, workflowEvidence,
  ] = await Promise.all([
    import('./support/environment.js'),
    import('./support/applicationLease.js'),
    import('./support/cacheMaintenance.js'),
    import('./support/evidenceLease.js'),
    import('./support/stagingLease.js'),
    import('./support/workflowEvidence.js'),
  ]);
  return {
    ...environment,
    ...applicationLease,
    ...cacheMaintenance,
    ...evidenceLease,
    ...stagingLease,
    ...workflowEvidence,
  };
};

export const run = async ({ repeat, journeys }) => {
  const {
    APPLICATION_BINARY, INHERITED_APPLICATION_LEASE, assertAutomationDialogGuard,
    beginWorkflowEvidence, createRunRoot, finalizeWorkflowEvidence, preserveRunRootEvidence,
    createE2eCacheMaintenanceBatch,
    readVerifiedCurrentPublishedApplication, refreshWorkflowEvidenceIndex, removeRunRoot,
    runRootAuthorization, serializeInheritedApplicationLease, workflowNameForJourney,
  } = await loadLaunchRuntime();
  // Reject an absent, corrupt, dirty, or historical publication before evidence/cache mutation.
  // The lease-protected verification below remains authoritative for the actual launch.
  readVerifiedCurrentPublishedApplication();
  const failures = [];
  const started = Date.now();
  const cacheMaintenance = createE2eCacheMaintenanceBatch();
  // Self-heal the browsable evidence index before trusting or extending it: a prior run killed
  // between an attempt's manifest write and its index refresh (see workflowEvidence.js) can leave
  // the index stale for a workflow this invocation never touches. Refreshing again once the loop
  // finishes (even if it throws) keeps the index truthful for whatever this run actually recorded.
  refreshWorkflowEvidenceIndex();
  try {
    for (let iteration = 1; iteration <= repeat; iteration += 1) {
      for (const journey of journeys) {
        const label = `${basename(journey)} (${iteration}/${repeat})`;
        const workflow = workflowNameForJourney(journey);
        cacheMaintenance.withLeases(({
          applicationLease, evidenceLease, stagingLease,
        }) => {
          const publication = readVerifiedCurrentPublishedApplication();
          if (!samePath(publication.binaryPath, APPLICATION_BINARY)) {
            fail('the leased immutable binary changed after the isolated runner loaded');
          }
          assertAutomationDialogGuard(publication.binaryPath);
          const inheritedApplication = serializeInheritedApplicationLease({
            lease: applicationLease,
            publication,
          });
          const runRoot = createRunRoot({ stagingLease });
          const runAuthorization = runRootAuthorization(runRoot);
          const attempt = beginWorkflowEvidence({
            workflow,
            journey: relative(E2E_ROOT, journey).replaceAll('\\', '/'),
            iteration,
            applicationHash: publication.applicationHash,
            binaryPath: publication.binaryPath,
          });
          process.stdout.write(`\n=== isolated journey: ${label} ===\n`);
          const environment = isolatedEnvironment(process.env);
          environment.OSG_E2E_WORKFLOW = workflow;
          environment.OSG_E2E_EVIDENCE_ATTEMPT = attempt.id;
          environment.OSG_E2E_DATA_ROOT = runRoot;
          environment.OSG_E2E_REUSE_ROOT = '1';
          environment.OSG_E2E_RUN_ROOT_AUTHORIZATION = runAuthorization;
          environment[INHERITED_APPLICATION_LEASE] = inheritedApplication;
          let result;
          try {
            result = runSupervisedSync({
              command: process.execPath,
              args: [WDIO, 'run', CONFIG, '--spec', journey],
              cwd: E2E_ROOT,
              env: environment,
              stdio: 'inherit',
              ownerProcessId: process.pid,
              managedPaths: [
                ...applicationLease.managedPaths,
                ...stagingLease.managedPaths,
                evidenceLease.evidenceRoot,
              ],
            });
            const passed = !result.error && result.status === 0;
            if (!passed) {
              // The old architecture claimed a failed run root was "kept", but this finally has
              // always removed it, so the per-case artifacts a journey staged under
              // <root>/evidence died with the root. Promote them into the durable attempt through
              // the publisher before the root goes away; diagnosis of a deterministic failure
              // depends on it.
              try {
                const kept = preserveRunRootEvidence({ workflow, runRoot, attemptId: attempt.id });
                if (kept.preserved > 0 || kept.skipped > 0) {
                  process.stdout.write(
                    `\n--- run-root evidence preserved in attempt ${attempt.id}: `
                    + `${kept.preserved} file(s), ${kept.skipped} skipped ---\n`,
                  );
                }
              } catch (error) {
                process.stdout.write(
                  `\n--- run-root evidence could not be preserved: ${error.message} ---\n`,
                );
              }
            }
            finalizeWorkflowEvidence({
              workflow,
              attemptId: attempt.id,
              outcome: passed ? 'pass' : 'fail',
              exitStatus: result.status,
              signal: result.signal,
              failure: result.error?.message ?? null,
            });
            // A supervisor-level error on ONE journey must not abort the remaining suite: the old
            // throw here unwound every lease and silently dropped seventeen queued journeys when
            // a single spawn failed mid-suite. Record it loudly and keep going.
            if (result.error) {
              process.stdout.write(`\nFAILED ${label}: supervisor error: ${result.error.message}\n`);
            }
            if (!passed) failures.push({ label, status: result.status ?? 'supervisor-error' });
          } finally {
            removeRunRoot(runRoot, runAuthorization);
          }
        });
      }
    }
  } finally {
    refreshWorkflowEvidenceIndex();
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
  await run(parseArguments(process.argv.slice(2)));
}
