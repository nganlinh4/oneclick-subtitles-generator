import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verificationExitCode, verifyInventoryState } from './verify-inventory.mjs';

const require = createRequire(import.meta.url);
const { publishE2eApplication } = require('../../scripts/e2e-application-publication.js');

const CURRENT = Object.freeze({ commit: '1'.repeat(40), tree: '2'.repeat(40), dirty: false });
const OLD = Object.freeze({ commit: '3'.repeat(40), tree: '4'.repeat(40), dirty: false });
const ATTEMPT = '20260829000000000-1234-abcdef12';

const writeProfile = (profileRoot) => {
  mkdirSync(profileRoot, { recursive: true });
  writeFileSync(join(profileRoot, 'osg-desktop.exe'), 'MZ-byte-identical-e2e');
  for (const [directory, file] of [
    ['licenses', 'LICENSE'], ['ui-fonts', 'font.woff2'], ['workers', 'worker.py'],
  ]) {
    mkdirSync(join(profileRoot, directory), { recursive: true });
    writeFileSync(join(profileRoot, directory, file), `${directory}-fixture`);
  }
};

const fixture = (context, {
  applicationSource = CURRENT,
  evidenceSource = CURRENT,
  publishApplication = true,
  status = 'green',
  runsAgainst,
} = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'osg-inventory-verifier-'));
  context.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const evidenceRoot = join(root, 'evidence');
  const applicationCacheRoot = join(root, 'application-cache');
  const applicationsRoot = join(applicationCacheRoot, 'applications');
  const profileRoot = join(root, 'profile');
  const workflow = 'proof';
  const attemptRoot = join(evidenceRoot, workflow, 'attempts', ATTEMPT);
  mkdirSync(attemptRoot, { recursive: true });
  writeProfile(profileRoot);
  const digest = createHash('sha256')
    .update(readFileSync(join(profileRoot, 'osg-desktop.exe')))
    .digest('hex');
  let application = null;
  if (publishApplication) {
    mkdirSync(applicationCacheRoot, { recursive: true });
    application = publishE2eApplication({
      profileRoot,
      applicationsCacheRoot: applicationCacheRoot,
      sourceProvenance: applicationSource,
    });
  }
  writeFileSync(join(evidenceRoot, workflow, 'latest-success.json'), JSON.stringify({
    schemaVersion: 1,
    workflow,
    attemptId: ATTEMPT,
    path: `attempts/${ATTEMPT}`,
    commit: evidenceSource.commit,
    tree: evidenceSource.tree,
    dirty: evidenceSource.dirty,
    binarySha256: digest,
  }));
  writeFileSync(join(attemptRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 2,
    publisher: 'osg-e2e-workflow-evidence',
    workflow,
    attempt: { id: ATTEMPT, outcome: 'pass' },
    provenance: { source: evidenceSource, binary: { sha256: digest } },
  }));
  const journey = {
    name: 'capability',
    status,
    evidenceWorkflow: workflow,
    attemptId: 'stale-attempt',
    binaryDigest: '5'.repeat(64),
  };
  if (runsAgainst !== undefined) journey.runsAgainst = runsAgainst;
  const inventory = {
    journeys: [journey],
    suiteRun: { verify: 'node e2e/scripts/verify-inventory.mjs --require-current' },
  };
  return {
    application,
    applicationsRoot,
    evidenceRoot,
    inventory,
    currentSource: CURRENT,
  };
};

test('exact evidence, application, and clean source identity produce current proof', (context) => {
  const report = verifyInventoryState(fixture(context));
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.staleBindings, ['capability']);
  assert.equal(report.local[0].attemptId, ATTEMPT);
  assert.equal(report.classifications['current-head'], 1);
  assert.deepEqual(report.closureBlockers, []);
});

test('byte-identical executable from old evidence never becomes current through a newer app', (context) => {
  const input = fixture(context, { applicationSource: CURRENT, evidenceSource: OLD });
  const report = verifyInventoryState(input);
  assert.deepEqual(report.failures, []);
  assert.equal(report.classifications['current-head'], 0);
  assert.equal(report.classifications['historical-retained'], 1);
  assert.match(report.closureBlockers[0], /lacks exact current-HEAD proof/u);
});

test('forged retained manifest is rejected instead of supplying source provenance', (context) => {
  const input = fixture(context, { applicationSource: OLD, evidenceSource: CURRENT });
  const manifest = JSON.parse(readFileSync(input.application.manifestPath, 'utf8'));
  manifest.source = CURRENT;
  writeFileSync(input.application.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const report = verifyInventoryState(input);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0], /manifest hash mismatch|corrupted manifest/u);
  assert.equal(report.classifications['current-head'], 0);
  assert.equal(report.classifications['historical-rotated'], 1);
});

test('retained application file drift is rejected against its immutable inventory', (context) => {
  const input = fixture(context);
  writeFileSync(input.application.binaryPath, 'MZ-forged-after-publication');
  const report = verifyInventoryState(input);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0], /corrupted inventory/u);
  assert.equal(report.classifications['historical-rotated'], 1);
});

test('legacy evidence without a tree stays historical even at the same commit and binary', (context) => {
  const input = fixture(context);
  const pointerPath = join(input.evidenceRoot, 'proof', 'latest-success.json');
  const manifestPath = join(input.evidenceRoot, 'proof', 'attempts', ATTEMPT, 'manifest.json');
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete pointer.tree;
  delete manifest.provenance.source.tree;
  writeFileSync(pointerPath, JSON.stringify(pointer));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const report = verifyInventoryState(input);
  assert.deepEqual(report.failures, []);
  assert.equal(report.classifications['current-head'], 0);
  assert.equal(report.classifications['historical-retained'], 1);
});

test('dirty current source is audit-visible history and blocks closure', (context) => {
  const input = fixture(context);
  input.currentSource = { ...CURRENT, dirty: true };
  const report = verifyInventoryState(input);
  assert.deepEqual(report.failures, []);
  assert.equal(report.classifications['historical-retained'], 1);
  assert.equal(report.closureBlockers[0], 'current source worktree is dirty');
  assert.equal(report.closureBlockers.length, 2);
});

test('zero-current and historical-only ledgers fail closure without hiding history', (context) => {
  const zeroReport = verifyInventoryState(fixture(context, { publishApplication: false }));
  assert.equal(zeroReport.classifications['historical-rotated'], 1);
  assert.equal(zeroReport.closureBlockers.length, 1);
  assert.equal(verificationExitCode(zeroReport), 0, 'ordinary audit preserves historical proof');
  assert.equal(verificationExitCode(zeroReport, { requireCurrent: true }), 1);

  const historical = fixture(context, { applicationSource: OLD, evidenceSource: OLD });
  const historicalReport = verifyInventoryState(historical);
  assert.equal(historicalReport.classifications['historical-retained'], 1);
  assert.equal(historicalReport.closureBlockers.length, 1);
});

test('pointer drift and hand-maintained suite snapshots fail closed', (context) => {
  const input = fixture(context);
  input.inventory.suiteRun.generatedStatusCounts = { green: 99 };
  const pointerPath = join(input.evidenceRoot, 'proof', 'latest-success.json');
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  pointer.tree = '6'.repeat(40);
  writeFileSync(pointerPath, JSON.stringify(pointer));
  const report = verifyInventoryState(input);
  assert.equal(report.failures.length, 2);
  assert.match(report.failures[0], /hand-maintained generated fields/u);
  assert.match(report.failures[1], /drifted from its immutable manifest/u);
});

test('external installed production proof is audit-only and cannot close current source', (context) => {
  const report = verifyInventoryState(fixture(context, {
    runsAgainst: 'installed-production-binary',
  }));
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.external, ['capability']);
  assert.equal(report.local.length, 0);
  assert.match(report.closureBlockers[0], /cannot attest/u);
  assert.match(report.externalPolicy, /audit-only/u);
});

test('non-green journeys are explicit closure blockers', (context) => {
  const report = verifyInventoryState(fixture(context, { status: 'unproven' }));
  assert.equal(report.local.length, 0);
  assert.match(report.closureBlockers[0], /status unproven/u);
});
