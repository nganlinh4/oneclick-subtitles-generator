import { copyFileSync, readdirSync, statSync } from 'node:fs';
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
  'geminiBackgroundImageSuccess.journey.js',
  'geminiMultiWindowTranscription.journey.js',
  'geminiDocumentSuccess.journey.js',
  'geminiLiveMusicSuccess.journey.js',
  'geminiTranscriptionSuccess.journey.js',
  'geminiTranslationSuccess.journey.js',
  'geminiVideoAnalysisSuccess.journey.js',
  'longMediaOperationRecovery.journey.js',
  'longMediaResourceBounds.journey.js',
  'multiWindowAsrPersistence.journey.js',
  'nativeToolsInstall.journey.js',
  'reconnaissance.journey.js',
  'renderInterruptRecovery.journey.js',
  'settingsAppearancePersistence.journey.js',
  'settingsCredentialLifecycle.journey.js',
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
  .sort((left, right) => {
    if (left === 'urlToPreview.journey.js') return -1;
    if (right === 'urlToPreview.journey.js') return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  })
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

/** Keep disposable-root cleanup structurally inseparable from staging and process launch. */
export const withDisposableRunRoot = ({
  stagingLease, createRunRoot, runRootAuthorization, removeRunRoot,
}, operation, onFailureBeforeCleanup = () => {}) => {
  const runRoot = createRunRoot({ stagingLease });
  const authorization = runRootAuthorization(runRoot);
  try {
    return operation({ runRoot, runAuthorization: authorization });
  } catch (error) {
    onFailureBeforeCleanup({ runRoot, runAuthorization: authorization }, error);
    throw error;
  } finally {
    removeRunRoot(runRoot, authorization);
  }
};

const boundedHarnessError = (error) => Object.freeze({
  name: String(error?.name ?? 'Error').slice(0, 120),
  message: String(error?.message ?? error ?? 'unknown harness failure').slice(0, 2_000),
  stack: typeof error?.stack === 'string' ? error.stack.slice(0, 12_000) : null,
});

/**
 * One harness failure is one failed journey, not permission to discard the rest of the queue.
 * `onFailure` runs before this returns, while the caller still owns every cache/evidence lease.
 */
export const runContainedJourneyOperation = ({
  failures, label, onFailure, operation, write = (value) => process.stdout.write(value),
}) => {
  try {
    return operation();
  } catch (error) {
    let evidenceError = null;
    try {
      onFailure(error);
    } catch (failure) {
      evidenceError = failure;
    }
    const harnessError = boundedHarnessError(error);
    failures.push({ label, status: 'harness-error', failure: harnessError.message });
    write(`\nFAILED ${label}: harness error: ${harnessError.message}\n`);
    if (evidenceError !== null) {
      write(
        `FAILED ${label}: harness-failure evidence could not be finalized: `
        + `${boundedHarnessError(evidenceError).message}\n`,
      );
    }
    return undefined;
  }
};

const loadLaunchRuntime = async () => {
  const [
    environment, applicationLease, cacheMaintenance, evidenceLease, journeyMedia, longMedia,
    realMedia, stagingLease, workflowEvidence,
  ] = await Promise.all([
    import('./support/environment.js'),
    import('./support/applicationLease.js'),
    import('./support/cacheMaintenance.js'),
    import('./support/evidenceLease.js'),
    import('./support/journeyMediaRequirements.js'),
    import('./support/longSyntheticMediaFixture.js'),
    import('./support/realMedia.js'),
    import('./support/stagingLease.js'),
    import('./support/workflowEvidence.js'),
  ]);
  return {
    ...environment,
    ...applicationLease,
    ...cacheMaintenance,
    ...evidenceLease,
    ...journeyMedia,
    ...longMedia,
    ...realMedia,
    ...stagingLease,
    ...workflowEvidence,
  };
};

export const run = async ({ repeat, journeys }) => {
  const {
    APPLICATION_BINARY, INHERITED_APPLICATION_LEASE, assertAutomationDialogGuard,
    beginWorkflowEvidence, createRunRoot, finalizeWorkflowEvidence, preserveRunRootEvidence,
    recordWorkflowDiagnostic,
    createE2eCacheMaintenanceBatch,
    ensureLongSyntheticMedia, ensureRealVideo, ensureSourceSwitchVideo,
    verifiedDownloadIdentityVideo,
    JOURNEY_MEDIA_REQUIREMENT, journeyMediaRequirement,
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
        const failureCountBeforeLease = failures.length;
        try {
          cacheMaintenance.withLeases(({
            applicationLease, evidenceLease, stagingLease,
          }) => {
            let phase = 'publication-verification';
            let publication = null;
            let attempt = null;
            let attemptFinalized = false;
            const priorAttempt = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
            const restoreAttempt = () => {
              if (priorAttempt === undefined) delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
              else process.env.OSG_E2E_EVIDENCE_ATTEMPT = priorAttempt;
            };
            try {
              return runContainedJourneyOperation({
                failures,
                label,
                operation: () => {
                  publication = readVerifiedCurrentPublishedApplication();
                  if (!samePath(publication.binaryPath, APPLICATION_BINARY)) {
                    fail('the leased immutable binary changed after the isolated runner loaded');
                  }
                  phase = 'evidence-bootstrap';
                  attempt = beginWorkflowEvidence({
                    workflow,
                    journey: relative(E2E_ROOT, journey).replaceAll('\\', '/'),
                    iteration,
                    applicationHash: publication.applicationHash,
                    binaryPath: publication.binaryPath,
                  });
                  process.env.OSG_E2E_EVIDENCE_ATTEMPT = attempt.id;
                  phase = 'binary-capability-check';
                  assertAutomationDialogGuard(publication.binaryPath);
                  phase = 'media-bootstrap';
                  const requirement = journeyMediaRequirement(journey);
                  const preparedRealMedia = requirement === JOURNEY_MEDIA_REQUIREMENT.generic
                    ? ensureRealVideo({ applicationLease })
                    : null;
                  const journeyName = basename(journey);
                  const needsSourceSwitch = new Set([
                    'downloadCancellationRetryIdentity.journey.js',
                    'failedDownloadNoStale.journey.js',
                    'mainPreviewControlsAndFullscreen.journey.js',
                  ]).has(journeyName);
                  const preparedSourceSwitch = needsSourceSwitch
                    ? ensureSourceSwitchVideo({ applicationLease })
                    : null;
                  const preparedLongMedia = journeyName === 'longMediaResourceBounds.journey.js'
                    ? ensureLongSyntheticMedia({ applicationLease })
                    : null;
                  const inheritedApplication = serializeInheritedApplicationLease({
                    lease: applicationLease,
                    publication,
                  });
                  phase = 'run-root-staging';
                  return withDisposableRunRoot({
                    stagingLease, createRunRoot, runRootAuthorization, removeRunRoot,
                  }, ({ runRoot, runAuthorization }) => {
                    const environment = isolatedEnvironment(process.env);
                    environment.OSG_E2E_WORKFLOW = workflow;
                    environment.OSG_E2E_DATA_ROOT = runRoot;
                    environment.OSG_E2E_REUSE_ROOT = '1';
                    environment.OSG_E2E_RUN_ROOT_AUTHORIZATION = runAuthorization;
                    environment[INHERITED_APPLICATION_LEASE] = inheritedApplication;
                    const stageMedia = (source, prefix = '') => {
                      const staged = join(runRoot, 'input', `${prefix}${basename(source)}`);
                      copyFileSync(source, staged);
                      return staged;
                    };
                    if (preparedRealMedia !== null) {
                      environment.OSG_E2E_MEDIA_SELECTION = stageMedia(preparedRealMedia);
                    }
                    if (journeyName === 'mainPreviewControlsAndFullscreen.journey.js') {
                      const stagedSwitch = stageMedia(preparedSourceSwitch, 'switch-');
                      environment.OSG_E2E_MEDIA_SELECTION_SEQUENCE = JSON.stringify([
                        environment.OSG_E2E_MEDIA_SELECTION,
                        stagedSwitch,
                      ]);
                    }
                    if (journeyName === 'longMediaResourceBounds.journey.js') {
                      const stagedLong = stageMedia(preparedLongMedia);
                      environment.OSG_E2E_MEDIA_SELECTION = stagedLong;
                    }
                    if (new Set([
                      'downloadCancellationRetryIdentity.journey.js',
                      'failedDownloadNoStale.journey.js',
                    ]).has(journeyName)) {
                      environment.OSG_E2E_SOURCE_SWITCH_MEDIA = stageMedia(
                        preparedSourceSwitch,
                        'source-a-',
                      );
                      environment.OSG_E2E_DOWNLOAD_IDENTITY_MEDIA = stageMedia(
                        verifiedDownloadIdentityVideo(),
                        'source-b-',
                      );
                    }
                    environment.OSG_E2E_EVIDENCE_ATTEMPT = attempt.id;
                    process.stdout.write(`\n=== isolated journey: ${label} ===\n`);
                    phase = 'desktop-launch';
                    const result = runSupervisedSync({
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
                      // The old architecture claimed a failed run root was "kept", but this
                      // finally has always removed it, so the per-case artifacts staged under
                      // <root>/evidence died with the root. Publish them before cleanup.
                      try {
                        const kept = preserveRunRootEvidence({
                          workflow, runRoot, attemptId: attempt.id,
                        });
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
                    attemptFinalized = true;
                    // One supervisor error must not discard the remaining queued journeys.
                    if (result.error) {
                      process.stdout.write(
                        `\nFAILED ${label}: supervisor error: ${result.error.message}\n`,
                      );
                    }
                    if (!passed) {
                      failures.push({ label, status: result.status ?? 'supervisor-error' });
                    }
                    return passed;
                  }, ({ runRoot }) => {
                    if (attempt === null) return;
                    try {
                      preserveRunRootEvidence({ workflow, runRoot, attemptId: attempt.id });
                    } catch {
                      // The typed harness record and terminal manifest remain more important than
                      // an optional staged screenshot that itself became unreadable.
                    }
                  });
                },
                onFailure: (error) => {
                  if (attempt === null || publication === null) return;
                  process.env.OSG_E2E_EVIDENCE_ATTEMPT = attempt.id;
                  const detail = boundedHarnessError(error);
                  try {
                    recordWorkflowDiagnostic({
                      workflow,
                      name: 'harness-failure',
                      file: 'diagnostics/harness-failure.json',
                      description: 'A typed launcher/bootstrap failure captured before disposable-root cleanup.',
                      document: {
                        schemaVersion: 1,
                        kind: 'harness-failure',
                        phase,
                        error: detail,
                      },
                    });
                  } finally {
                    if (!attemptFinalized) {
                      finalizeWorkflowEvidence({
                        workflow,
                        attemptId: attempt.id,
                        outcome: 'fail',
                        exitStatus: null,
                        signal: null,
                        failure: `harness failure during ${phase}: ${detail.message}`,
                      });
                      attemptFinalized = true;
                    }
                  }
                },
              });
            } finally {
              restoreAttempt();
            }
          });
        } catch (error) {
          // Lease acquisition/finalization can fail outside the callback, where evidence mutation
          // is no longer authorized. Keep the queue moving and surface the typed equivalent in the
          // run summary; callback failures have already appended their own harness record.
          if (failures.length === failureCountBeforeLease) {
            failures.push({
              label,
              status: 'lease-error',
              failure: boundedHarnessError(error).message,
            });
          }
          process.stdout.write(
            `\nFAILED ${label}: lease boundary error: ${boundedHarnessError(error).message}\n`,
          );
        }
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
