import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  basename, dirname, join, relative, resolve, sep,
} from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import {
  assertAutomationDialogGuard, createRunRoot, readVerifiedPublishedApplication, removeRunRoot,
  runRootAuthorization, scrubAutomationEnvironment,
} from './environment.js';
import {
  INHERITED_APPLICATION_LEASE, serializeInheritedApplicationLease,
} from './applicationLease.js';
import { createE2eCacheMaintenanceBatch } from './cacheMaintenance.js';
import {
  JOURNEY_MEDIA_REQUIREMENT, journeyMediaRequirement,
} from './journeyMediaRequirements.js';
import { ensureRealVideo } from './realMedia.js';
import {
  finalizeWorkflowEvidence,
  preserveRunRootEvidence,
  resetWorkflowEvidence,
  workflowNameForJourney,
} from './workflowEvidence.js';

/* global console */

const E2E_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WDIO = join(E2E_ROOT, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js');
const require = createRequire(import.meta.url);
const { runSupervisedSync } = require('../../scripts/windows-job-supervisor.js');

const sleepSync = (milliseconds) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  } catch {
    const untilMs = Date.now() + milliseconds;
    while (Date.now() < untilMs) { /* fallback busy-wait */ }
  }
};

const webviewProfileBusy = (root) => {
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '@(Get-CimInstance Win32_Process -Filter "Name=\'msedgewebview2.exe\'"'
      + ' | Where-Object { $_.CommandLine -match [regex]::Escape($env:OSG_E2E_WEBVIEW_PROFILE) }).Count',
    ], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, OSG_E2E_WEBVIEW_PROFILE: join(root, 'webview') },
    });
    return Number(output.trim()) > 0;
  } catch {
    return false;
  }
};

/**
 * A relaunch phase reuses the seed phase's WebView2 user-data folder, and Edge's browser
 * subprocesses release that profile asynchronously after the seed application exits. A fresh
 * process opening the profile during that release has twice fail-fasted silently at startup
 * (0xC0000409, nothing on stderr, an empty run root) — once in a stress iteration, once in this
 * exact seed-to-verify handoff. Wait, bounded, for every WebView process still naming the profile
 * to leave before launching the next phase.
 */
const awaitWebviewProfileRelease = (root) => {
  if (process.platform !== 'win32') return;
  for (let waitedMs = 0; waitedMs < 30_000 && webviewProfileBusy(root); waitedMs += 500) {
    sleepSync(500);
  }
};

export const runScenarioProcesses = ({
  label,
  root,
  phases,
  phaseVariable = 'OSG_E2E_PERSISTENCE_PHASE',
  resetEvidence = false,
  spec,
  stagedMediaSelection = null,
  inheritedApplication,
  managedPaths,
  publication = null,
}) => {
  if (typeof inheritedApplication !== 'string' || !Array.isArray(managedPaths)) {
    throw new Error('scenario processes require outer-owned application/staging/evidence leases');
  }
  const workflow = workflowNameForJourney(spec);
  if (resetEvidence) {
    if (
      publication === null
      || !/^[0-9a-f]{64}$/u.test(publication.applicationHash ?? '')
      || typeof publication.binaryPath !== 'string'
    ) {
      throw new Error('scenario evidence requires the exact verified application publication');
    }
    resetWorkflowEvidence(workflow, {
      applicationHash: publication.applicationHash,
      binaryPath: publication.binaryPath,
    });
  }
  let reviewedSelection = null;
  if (stagedMediaSelection !== null) {
    const inputRoot = realpathSync.native(join(root, 'input'));
    reviewedSelection = realpathSync.native(resolve(stagedMediaSelection));
    const inside = relative(inputRoot, reviewedSelection);
    const status = lstatSync(reviewedSelection);
    if (
      inside === ''
      || inside === '..'
      || inside.startsWith(`..${sep}`)
      || !status.isFile()
      || status.isSymbolicLink()
      || realpathSync.native(dirname(reviewedSelection)) !== inputRoot
    ) {
      throw new Error('the staged scenario media must be one ordinary file directly inside the isolated input root');
    }
  }
  const runPhase = (phase) => {
    const environment = {
      ...scrubAutomationEnvironment(process.env),
      OSG_E2E_DATA_ROOT: root,
      OSG_E2E_REUSE_ROOT: '1',
      OSG_E2E_RUN_ROOT_AUTHORIZATION: runRootAuthorization(root),

      OSG_E2E_WORKFLOW: workflow,
      ...(process.env.OSG_E2E_EVIDENCE_ATTEMPT === undefined
        ? {}
        : { OSG_E2E_EVIDENCE_ATTEMPT: process.env.OSG_E2E_EVIDENCE_ATTEMPT }),
      [phaseVariable]: phase,
      ...(reviewedSelection === null ? {} : { OSG_E2E_MEDIA_SELECTION: reviewedSelection }),
      [INHERITED_APPLICATION_LEASE]: inheritedApplication,
    };
    process.stdout.write(`\n=== ${label} process: ${phase} ===\n`);
    return runSupervisedSync({
      command: process.execPath,
      args: [WDIO, 'run', 'wdio.conf.js', '--spec', spec],
      cwd: E2E_ROOT,
      env: environment,
      stdio: 'inherit',
      ownerProcessId: process.pid,
      managedPaths,
    });
  };

  try {
    let firstPhase = true;
    for (const phase of phases) {
      if (!firstPhase) awaitWebviewProfileRelease(root);
      firstPhase = false;
      const result = runPhase(phase);
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${phase} process failed with exit ${result.status}`);
    }
    process.stdout.write(`\n${label} passed across ${phases.length} desktop process(es).\n`);
    return true;
  } catch (error) {
    console.error(`\n${label} failed; caller will publish bounded run-root evidence before cleanup`);
    console.error(error);
    return false;
  }
};

/**
 * Begin evidence before custom fixture staging and publish any root diagnostics before the caller
 * deletes that root. The injectable publisher exists so copy/bootstrap throws are unit-testable
 * without opening the managed evidence lane.
 */
export const runScenarioAttemptWithEvidence = ({
  label, operation, publication, root, spec,
}, publisher = {
  finalizeWorkflowEvidence,
  preserveRunRootEvidence,
  resetWorkflowEvidence,
}) => {
  const workflow = workflowNameForJourney(spec);
  const attemptDirectory = publisher.resetWorkflowEvidence(workflow, {
    applicationHash: publication.applicationHash,
    binaryPath: publication.binaryPath,
  });
  const attemptId = attemptDirectory.split(/[\\/]/u).at(-1);
  let failure = null;
  let succeeded = false;
  try {
    succeeded = operation();
    if (!succeeded) failure = `${label} did not complete every hidden desktop process`;
  } catch (error) {
    failure = String(error?.message ?? error ?? 'unknown scenario harness failure').slice(0, 2_000);
    console.error(`\n${label} failed during scenario bootstrap or staging`);
    console.error(error);
  } finally {
    if (!succeeded) {
      try {
        publisher.preserveRunRootEvidence({ workflow, runRoot: root, attemptId });
      } catch (error) {
        const preservationFailure = String(error?.message ?? error).slice(0, 1_000);
        failure = `${failure ?? `${label} failed`}; evidence preservation: ${preservationFailure}`;
      }
    }
    publisher.finalizeWorkflowEvidence({
      workflow,
      attemptId,
      outcome: succeeded ? 'pass' : 'fail',
      exitStatus: succeeded ? 0 : 1,
      failure,
    });
  }
  return succeeded;
};

export const withScenarioLeases = (operation) => createE2eCacheMaintenanceBatch().withLeases(
  ({ applicationLease, evidenceLease, stagingLease }) => {
    const publication = readVerifiedPublishedApplication();
    assertAutomationDialogGuard(publication.binaryPath);
    return operation(Object.freeze({
      applicationLease,
      stagingLease,
      evidenceLease,
      publication,
      inheritedApplication: serializeInheritedApplicationLease({
        lease: applicationLease,
        publication,
      }),
      managedPaths: Object.freeze([
        ...applicationLease.managedPaths,
        ...stagingLease.managedPaths,
        evidenceLease.evidenceRoot,
      ]),
    }));
  },
);

export const runTwoProcessScenario = ({ label, spec }) => {
  return withScenarioLeases(({
    applicationLease, inheritedApplication, managedPaths, publication, stagingLease,
  }) => {
      const preparedRealMedia = journeyMediaRequirement(spec) === JOURNEY_MEDIA_REQUIREMENT.generic
        ? ensureRealVideo({ applicationLease })
        : null;
      const root = createRunRoot({ stagingLease });
      const rootAuthorization = runRootAuthorization(root);
      try {
        return runScenarioAttemptWithEvidence({
          label, publication, root, spec,
          operation: () => {
            const stagedMediaSelection = preparedRealMedia === null ? null : (() => {
              const staged = join(root, 'input', basename(preparedRealMedia));
              copyFileSync(preparedRealMedia, staged);
              return staged;
            })();
            return runScenarioProcesses({
              label,
              root,
              phases: ['seed', 'verify'],
              spec,
              stagedMediaSelection,
              inheritedApplication,
              managedPaths,
              publication,
            });
          },
        });
      } finally {
        removeRunRoot(root, rootAuthorization);
        delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
      }
  });
};
