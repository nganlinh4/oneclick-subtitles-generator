// Evidence root resolution, publisher identity constants, and confined workflow/attempt directories.

import { strict as assert } from 'node:assert';
import { lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import { resolveDevelopmentCacheRoot } from '../developmentCacheRoot.js';

const require = createRequire(import.meta.url);
const { readAndVerifyE2eApplicationReceipt } = require(
  '../../../scripts/e2e-application-publication.js',
);
export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const developmentCacheRoot = () => resolveDevelopmentCacheRoot({ repositoryRoot: REPOSITORY_ROOT });
const applicationCacheRoot = () => join(developmentCacheRoot(), 'apps', 'e2e');
const defaultEvidenceRoot = () => join(developmentCacheRoot(), 'evidence');
export const readDefaultPublishedApplication = () => readAndVerifyE2eApplicationReceipt({
  applicationsCacheRoot: applicationCacheRoot(),
});

const TEST_EVIDENCE_OVERRIDE = 'OSG_E2E_WORKFLOW_EVIDENCE_ROOT';
const evidenceRootForProcess = () => {
  const requested = process.env[TEST_EVIDENCE_OVERRIDE];
  if (requested === undefined) return defaultEvidenceRoot();
  if (process.env.NODE_TEST_CONTEXT === undefined) {
    throw new Error(`${TEST_EVIDENCE_OVERRIDE} is available only to a Node test subprocess`);
  }
  if (
    !isAbsolute(requested)
    || requested.split(/[\\/]+/u).some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`${TEST_EVIDENCE_OVERRIDE} must be an absolute traversal-free test path`);
  }
  const status = lstatSync(requested);
  const canonical = realpathSync.native(requested);
  const temporary = realpathSync.native(tmpdir());
  const same = (left, right) => (
    process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  );
  if (
    !status.isDirectory()
    || status.isSymbolicLink()
    || !same(dirname(canonical), temporary)
    || !basename(canonical).startsWith('osg-workflow-evidence-test-')
  ) {
    throw new Error(`${TEST_EVIDENCE_OVERRIDE} must be one private direct child of the OS temp root`);
  }
  return canonical;
};

export const WORKFLOW_EVIDENCE_ROOT = evidenceRootForProcess();
export const ATTEMPT_ENVIRONMENT_KEY = 'OSG_E2E_EVIDENCE_ATTEMPT';
export const ATTEMPT_ID_PATTERN = /^\d{17}-\d{1,10}-[0-9a-f]{8}$/u;
export const EVIDENCE_PUBLISHER = 'osg-e2e-workflow-evidence';
export const workflowNameForJourney = (journey) => basename(journey, '.journey.js')
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  .toLowerCase();

export const safeSegment = (value, label) => {
  assert.match(value, /^[a-z0-9][a-z0-9-]{0,79}$/, `${label} must be a bounded slug`);
  return value;
};

export const insideDirectory = (root, candidate, label) => {
  const inside = relative(resolve(root), resolve(candidate));
  assert.ok(
    inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`),
    `${label} escaped its evidence root`,
  );
  return candidate;
};

export const workflowEvidenceDirectory = (workflow) => {
  const directory = resolve(WORKFLOW_EVIDENCE_ROOT, safeSegment(workflow, 'workflow'));
  return insideDirectory(WORKFLOW_EVIDENCE_ROOT, directory, 'workflow');
};

export const attemptDirectory = (workflow, attemptId) => {
  const root = workflowEvidenceDirectory(workflow);
  const directory = resolve(root, 'attempts', safeSegment(attemptId, 'attempt'));
  return insideDirectory(join(root, 'attempts'), directory, 'attempt');
};
