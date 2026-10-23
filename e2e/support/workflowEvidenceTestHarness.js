// Shared setup for the workflow-evidence tests: a private evidence root that must exist before
// workflowEvidence.js is first imported, the module under test, and common fixtures.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const workflowEvidenceTestRoot = mkdtempSync(join(tmpdir(), 'osg-workflow-evidence-test-'));
const priorEvidenceRoot = process.env.OSG_E2E_WORKFLOW_EVIDENCE_ROOT;
process.env.OSG_E2E_WORKFLOW_EVIDENCE_ROOT = workflowEvidenceTestRoot;

export const derivativeFixture = (baseApplicationHash) => {
  const directories = [];
  const files = [{
    path: 'osg-desktop.exe',
    size: 3,
    sha256: createHash('sha256').update('app').digest('hex'),
  }];
  return {
    kind: 'staged-damage',
    baseApplicationHash,
    treeSha256: createHash('sha256')
      .update(`${JSON.stringify({ directories, files })}\n`).digest('hex'),
    directories,
    files,
    delta: {
      change: 'deleted',
      path: 'ui-fonts/Inter-Regular.ttf',
      base: { size: 4, sha256: createHash('sha256').update('font').digest('hex') },
      derived: null,
    },
  };
};

export const {
  WORKFLOW_EVIDENCE_ROOT,
  applyWorkflowEvidenceRetention,
  beginWorkflowEvidence,
  boundedWorkflowTestFailure,
  captureWorkflowStep,
  collectVisibleStateFromPage,
  copyWorkflowArtifact,
  finalizeWorkflowEvidence,
  promoteWorkflowFailureEvidence,
  recordWorkflowTestFailure,
  refreshWorkflowEvidenceIndex,
  resetWorkflowEvidence,
  runRootArtifactName,
  validateVisibleState,
  workflowEvidenceDirectory,
  workflowFailureStepForTest,
  workflowNameForJourney,
} = await import('./workflowEvidence.js');

/** Restore the caller's evidence-root override and remove this process's private root. */
export const cleanupWorkflowEvidenceTestRoot = () => {
  if (priorEvidenceRoot === undefined) delete process.env.OSG_E2E_WORKFLOW_EVIDENCE_ROOT;
  else process.env.OSG_E2E_WORKFLOW_EVIDENCE_ROOT = priorEvidenceRoot;
  rmSync(workflowEvidenceTestRoot, { recursive: true, force: true });
};

export const workflowForTest = (name) => `contract-${name}-${process.pid}`;
export const workflowEvidenceModuleUrl = new URL('./workflowEvidence.js', import.meta.url).href;
export const fixedProvenance = () => ({
  source: {
    commit: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false,
    dirtyEntries: [], dirtyEntriesTruncated: false,
  },
  binary: { path: resolve('osg-e2e-test.exe'), exists: false, sha256: null, size: null },
});

export const runEvidenceCrashChild = ({ crashPoint, source }) => spawnSync(
  process.execPath,
  ['--input-type=module', '--eval', source],
  {
    cwd: resolve(import.meta.dirname, '..', '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: 'evidence-hard-kill-child',
      OSG_E2E_WORKFLOW_EVIDENCE_ROOT: workflowEvidenceTestRoot,
      OSG_E2E_TEST_EVIDENCE_CRASH_POINT: crashPoint,
    },
    windowsHide: true,
  },
);
