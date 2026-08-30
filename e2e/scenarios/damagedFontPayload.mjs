import { statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import jobSupervisor from '../../scripts/windows-job-supervisor.js';

import {
  corruptFontResource,
  describeStagedApplicationDerivative,
  assertStagedApplicationDerivative,
  discardStagedApplication,
  removeFontResource,
  stageApplication,
  stagedBinary,
  stagedFontResources,
} from '../support/stageApplication.js';
import {
  createRunRoot, removeRunRoot, runRootAuthorization, scrubAutomationEnvironment,
} from '../support/environment.js';
import { INHERITED_APPLICATION_LEASE } from '../support/applicationLease.js';
import { withScenarioLeases } from '../support/twoProcessScenario.js';
import {
  beginWorkflowEvidence, finalizeWorkflowEvidence, workflowNameForJourney,
} from '../support/workflowEvidence.js';

/* global console */

/**
 * Run the font journey against installations whose shipped font bytes are damaged.
 *
 * A separate runner because the harness resolves the binary when its configuration loads, so one
 * `wdio` invocation tests one installation. Each case below stages its own copy, breaks it in one
 * specific way, and runs the same journey against it.
 *
 * WHAT IS ASSERTED IS THE GUARANTEE, NOT THE OUTCOME. With a network the delivery fallback repairs
 * a damaged bundle and the font becomes ready; without one it cannot, and the application must say
 * so with a typed cause. Both are correct. What is never correct is waiting forever, and that is
 * what the journey checks, so this is deterministic on a build machine and on an air-gapped one.
 */

// The WOFF2 subsets are the largest bundled font resources. Damage the largest one so a reported
// Ready state must be backed by repaired bytes the WebView actually draws; damaging only a notice
// file would test package provenance while leaving the rendering capability intact.
const activeFontResource = (staged) => stagedFontResources(staged).sort((left, right) => (
  statSync(join(staged, 'ui-fonts', right)).size
    - statSync(join(staged, 'ui-fonts', left)).size
))[0];

const CASES = [
  {
    name: 'a shipped font resource whose bytes are not what its name claims',
    damage: (staged) => {
      const first = activeFontResource(staged);
      if (!first) throw new Error('the staged application ships no font resources to damage');
      // Same length, different bytes: only the digest can tell, which is the point of naming a
      // resource after its own hash.
      const bytes = corruptFontResource(staged, first);
      return { path: `ui-fonts/${first}`, change: 'changed', detail: `${bytes} bytes replaced` };
    },
  },
  {
    name: 'a shipped font resource that is missing entirely',
    damage: (staged) => {
      const first = activeFontResource(staged);
      if (!first) throw new Error('the staged application ships no font resources to damage');
      removeFontResource(staged, first);
      return { path: `ui-fonts/${first}`, change: 'deleted', detail: 'removed' };
    },
  },
];

const E2E_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPEC = './journeys/damagedFontPayload.journey.js';
const WDIO = join(E2E_ROOT, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js');
const WORKFLOW = workflowNameForJourney(SPEC);
const { runSupervisedSync } = jobSupervisor;

let failures = 0;

for (const [index, testCase] of CASES.entries()) {
  try {
    withScenarioLeases(({
      applicationLease, inheritedApplication, managedPaths, publication, stagingLease,
    }) => {
      const staged = stageApplication({ applicationLease, stagingLease });
      const root = createRunRoot({
        keepNativeTools: false,
        keepEnginePackages: false,
        stagingLease,
      });
      const rootAuthorization = runRootAuthorization(root);
      try {
        const damaged = testCase.damage(staged);
        const derivative = describeStagedApplicationDerivative({
          staged,
          publication,
          expectedPath: damaged.path,
          expectedChange: damaged.change,
        });
        console.log(`\n=== ${testCase.name}\n    damaged: ${damaged.path} (${damaged.detail})`);
        const binary = stagedBinary(staged);
        const attempt = beginWorkflowEvidence({
          workflow: WORKFLOW,
          journey: SPEC,
          iteration: index + 1,
          applicationHash: publication.applicationHash,
          applicationDerivative: derivative,
          binaryPath: binary,
        });
        const environment = {
          ...scrubAutomationEnvironment(process.env),
          OSG_E2E_BINARY: binary,
          OSG_E2E_APPLICATION_DERIVATIVE: JSON.stringify(derivative),
          OSG_E2E_WORKFLOW: WORKFLOW,
          OSG_E2E_EVIDENCE_ATTEMPT: attempt.id,
          OSG_E2E_DATA_ROOT: root,
          OSG_E2E_REUSE_ROOT: '1',
          OSG_E2E_RUN_ROOT_AUTHORIZATION: rootAuthorization,
          [INHERITED_APPLICATION_LEASE]: inheritedApplication,
        };
        // This is the final same-process authority boundary before WebdriverIO can spawn the app.
        // Re-reading the complete tree here closes the gap between describing damage and using it.
        assertStagedApplicationDerivative({ staged, publication, derivative });
        const supervised = runSupervisedSync({
          command: process.execPath,
          args: [WDIO, 'run', 'wdio.conf.js', '--spec', SPEC],
          cwd: E2E_ROOT,
          env: environment,
          stdio: 'inherit',
          ownerProcessId: process.pid,
          managedPaths,
        });
        let derivativeError = null;
        try {
          // A success may be published only while the staged bytes still equal the inventory the
          // immutable attempt names. The application repairs its private profile, never its bundle.
          assertStagedApplicationDerivative({ staged, publication, derivative });
        } catch (error) {
          derivativeError = error;
        }
        const passed = !supervised.error && supervised.status === 0 && derivativeError === null;
        finalizeWorkflowEvidence({
          workflow: WORKFLOW,
          attemptId: attempt.id,
          outcome: passed ? 'pass' : 'fail',
          exitStatus: supervised.status,
          signal: supervised.signal,
          failure: supervised.error?.message
            ?? derivativeError?.message
            ?? (passed ? null : `${testCase.name} failed`),
        });
        if (supervised.error) throw supervised.error;
        if (derivativeError) throw derivativeError;
        if (!passed) throw new Error(`${testCase.name} exited with ${supervised.status}`);
      } finally {
        removeRunRoot(root, rootAuthorization);
        discardStagedApplication(staged);
      }
    });
  } catch (error) {
    failures += 1;
    console.error(`FAILED: ${testCase.name}`);
    console.error(error);
  }
}

if (failures > 0) {
  console.error(`\n${failures} damaged-payload case(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${CASES.length} damaged-payload cases behaved correctly.`);
}
