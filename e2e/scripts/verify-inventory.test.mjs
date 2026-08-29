import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyInventoryState } from './verify-inventory.mjs';

const SOURCE = Object.freeze({ commit: '1'.repeat(40), tree: '2'.repeat(40), dirty: false });
const DIGEST = '3'.repeat(64);
const ATTEMPT = '20260829000000000-1234-abcdef12';

const fixture = (context) => {
  const root = mkdtempSync(join(tmpdir(), 'osg-inventory-verifier-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const evidenceRoot = join(root, 'evidence');
  const applicationsRoot = join(root, 'applications');
  const workflow = 'proof';
  const attemptRoot = join(evidenceRoot, workflow, 'attempts', ATTEMPT);
  mkdirSync(attemptRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, workflow, 'latest-success.json'), JSON.stringify({
    schemaVersion: 1,
    workflow,
    attemptId: ATTEMPT,
    path: `attempts/${ATTEMPT}`,
    commit: SOURCE.commit,
    dirty: false,
    binarySha256: DIGEST,
  }));
  writeFileSync(join(attemptRoot, 'manifest.json'), JSON.stringify({
    attempt: { id: ATTEMPT, outcome: 'pass' },
    provenance: { source: { commit: SOURCE.commit }, binary: { sha256: DIGEST } },
  }));
  const applicationRoot = join(applicationsRoot, '4'.repeat(64));
  mkdirSync(applicationRoot, { recursive: true });
  writeFileSync(join(applicationRoot, '.osg-application-manifest.json'), JSON.stringify({
    entrypoint: 'osg-desktop.exe',
    source: SOURCE,
    files: [{ path: 'osg-desktop.exe', sha256: DIGEST }],
  }));
  const inventory = {
    journeys: [{
      name: 'capability',
      status: 'green',
      evidenceWorkflow: workflow,
      attemptId: 'stale-attempt',
      binaryDigest: '5'.repeat(64),
    }],
    suiteRun: { verify: 'node e2e/scripts/verify-inventory.mjs' },
  };
  return { applicationsRoot, evidenceRoot, inventory };
};

test('latest-success overrides stale hand bindings and source provenance decides current proof', (context) => {
  const input = fixture(context);
  const current = verifyInventoryState({ ...input, currentSource: SOURCE });
  assert.deepEqual(current.failures, []);
  assert.deepEqual(current.staleBindings, ['capability']);
  assert.equal(current.local[0].attemptId, ATTEMPT);
  assert.equal(current.local[0].binaryDigest, DIGEST);
  assert.equal(current.classifications['current-head'], 1);

  const drifted = verifyInventoryState({
    ...input,
    currentSource: { ...SOURCE, tree: '6'.repeat(40) },
  });
  assert.equal(drifted.classifications['current-head'], 0);
  assert.equal(drifted.classifications['historical-retained'], 1);
});

test('pointer drift and hand-maintained suite snapshots fail closed', (context) => {
  const input = fixture(context);
  input.inventory.suiteRun.generatedStatusCounts = { green: 99 };
  const pointerPath = join(input.evidenceRoot, 'proof', 'latest-success.json');
  writeFileSync(pointerPath, JSON.stringify({
    workflow: 'proof',
    attemptId: ATTEMPT,
    path: `attempts/${ATTEMPT}`,
    commit: SOURCE.commit,
    binarySha256: '7'.repeat(64),
  }));
  const report = verifyInventoryState({ ...input, currentSource: SOURCE });
  assert.equal(report.failures.length, 2);
  assert.match(report.failures[0], /hand-maintained generated fields/u);
  assert.match(report.failures[1], /drifted from its immutable manifest/u);
});
