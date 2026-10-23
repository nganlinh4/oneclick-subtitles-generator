// Retention: newest attempts plus latest success, journal-authorized quarantine, foreign-tree refusal.

import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  WORKFLOW_EVIDENCE_ROOT, applyWorkflowEvidenceRetention, beginWorkflowEvidence,
  finalizeWorkflowEvidence, refreshWorkflowEvidenceIndex, resetWorkflowEvidence,
  workflowEvidenceDirectory, cleanupWorkflowEvidenceTestRoot, workflowForTest,
} from './workflowEvidenceTestHarness.js';

test.after(cleanupWorkflowEvidenceTestRoot);
test('keeps a failed rerun without replacing the latest successful proof', () => {
  const workflow = workflowForTest('promotion');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-contract-'));
  const binary = join(scratch, 'osg-e2e.exe');
  const bytes = Buffer.from('guarded-e2e-binary');
  writeFileSync(binary, bytes);
  try {
    const first = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/startup.journey.js',
      iteration: 1,
      applicationHash: 'c'.repeat(64),
      binaryPath: binary,
    });
    const passed = finalizeWorkflowEvidence({
      workflow,
      attemptId: first.id,
      outcome: 'pass',
      exitStatus: 0,
    });
    assert.equal(passed.provenance.binary.path, resolve(binary));
    assert.equal(
      passed.provenance.binary.sha256,
      createHash('sha256').update(bytes).digest('hex'),
    );
    assert.match(passed.provenance.source.commit, /^[0-9a-f]{40,64}$/);
    assert.match(passed.provenance.source.tree, /^[0-9a-f]{40,64}$/);
    assert.equal(typeof passed.provenance.source.dirty, 'boolean');
    assert.ok(passed.attempt.startedAt);
    assert.ok(passed.attempt.endedAt);

    const second = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/startup.journey.js',
      iteration: 2,
      binaryPath: binary,
    });
    finalizeWorkflowEvidence({
      workflow,
      attemptId: second.id,
      outcome: 'fail',
      exitStatus: 1,
      failure: 'visible regression',
    });

    const latest = JSON.parse(readFileSync(join(workflowDirectory, 'latest-success.json'), 'utf8'));
    assert.equal(latest.attemptId, first.id, 'failure must not replace the last successful pointer');
    assert.equal(latest.tree, passed.provenance.source.tree);
    assert.equal(latest.applicationHash, 'c'.repeat(64));
    assert.equal(passed.provenance.applicationHash, latest.applicationHash);
    assert.equal(existsSync(first.directory), true);
    assert.equal(existsSync(second.directory), true);
    const failed = JSON.parse(readFileSync(join(second.directory, 'manifest.json'), 'utf8'));
    assert.equal(failed.attempt.outcome, 'fail');
    assert.equal(failed.attempt.iteration, 2);
  } finally {
    rmSync(workflowDirectory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('retains the three newest attempts plus an older latest success, then retires superseded proof', () => {
  const workflow = workflowForTest('bounded-retention');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  const attemptsDirectory = join(workflowDirectory, 'attempts');
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-bounded-retention-'));
  const binary = join(scratch, 'osg-e2e.exe');
  writeFileSync(binary, 'guarded');
  const create = (ordinal, outcome) => {
    const startedAt = `2026-08-26T00:00:0${ordinal}.000Z`;
    const attempt = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/retention.journey.js',
      iteration: ordinal,
      binaryPath: binary,
      startedAt,
    });
    finalizeWorkflowEvidence({
      workflow,
      attemptId: attempt.id,
      outcome,
      exitStatus: outcome === 'pass' ? 0 : 1,
      failure: outcome === 'pass' ? null : `failure ${ordinal}`,
      endedAt: `2026-08-26T00:00:1${ordinal}.000Z`,
    });
    return attempt;
  };
  try {
    const first = create(1, 'pass');
    const second = create(2, 'fail');
    const third = create(3, 'fail');
    const fourth = create(4, 'fail');
    const fifth = create(5, 'fail');
    assert.equal(existsSync(first.directory), true, 'the latest successful proof was pruned');
    assert.equal(existsSync(second.directory), false, 'an attempt outside the bounded set survived');
    assert.deepEqual(
      [third, fourth, fifth].map(({ directory }) => existsSync(directory)),
      [true, true, true],
    );
    assert.equal(readFileSync(join(workflowDirectory, 'README.md'), 'utf8')
      .includes('three newest attempts plus the latest successful proof'), true);

    const sixth = create(6, 'pass');
    assert.equal(existsSync(first.directory), false, 'superseded success remained permanently pinned');
    assert.equal(existsSync(third.directory), false, 'fourth-newest attempt survived promotion');
    assert.deepEqual(
      [fourth, fifth, sixth].map(({ directory }) => existsSync(directory)),
      [true, true, true],
    );
    assert.equal(readdirSync(attemptsDirectory).length, 3);
    const pointer = JSON.parse(readFileSync(join(workflowDirectory, 'latest-success.json'), 'utf8'));
    assert.equal(pointer.attemptId, sixth.id);
    assert.deepEqual(applyWorkflowEvidenceRetention(workflow), { retained: 3, removed: 0 });
    assert.equal(existsSync(join(workflowDirectory, '.osg-workflow-evidence-trash')), false);
  } finally {
    rmSync(workflowDirectory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('retention fails before mutation when the attempts root contains foreign evidence', () => {
  const workflow = workflowForTest('foreign-retention-entry');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-foreign-retention-'));
  const binary = join(scratch, 'osg-e2e.exe');
  writeFileSync(binary, 'guarded');
  try {
    const attempt = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/foreign-retention.journey.js',
      iteration: 1,
      binaryPath: binary,
    });
    const foreign = join(workflowDirectory, 'attempts', 'foreign-directory');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'do-not-delete.txt'), 'foreign');
    assert.throws(() => finalizeWorkflowEvidence({
      workflow,
      attemptId: attempt.id,
      outcome: 'fail',
      exitStatus: 1,
    }), /unknown|publisher-owned/u);
    assert.equal(readFileSync(join(foreign, 'do-not-delete.txt'), 'utf8'), 'foreign');
    assert.equal(existsSync(attempt.directory), true);
  } finally {
    rmSync(workflowDirectory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('retention refuses a redirected candidate tree without touching its target', (context) => {
  const workflow = workflowForTest('reparse-retention-entry');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-reparse-retention-'));
  const binary = join(scratch, 'osg-e2e.exe');
  const target = join(scratch, 'foreign-target');
  const sentinel = join(target, 'sentinel.txt');
  writeFileSync(binary, 'guarded');
  mkdirSync(target);
  writeFileSync(sentinel, 'must survive');
  try {
    const attempts = [];
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      const attempt = beginWorkflowEvidence({
        workflow,
        journey: 'journeys/reparse-retention.journey.js',
        iteration: ordinal,
        binaryPath: binary,
        startedAt: `2026-08-26T01:00:0${ordinal}.000Z`,
      });
      finalizeWorkflowEvidence({
        workflow,
        attemptId: attempt.id,
        outcome: 'fail',
        exitStatus: 1,
        failure: `failure ${ordinal}`,
      });
      attempts.push(attempt);
    }
    const redirected = join(attempts[0].directory, 'redirected');
    try {
      symlinkSync(target, redirected, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        context.skip(`this host cannot create a test reparse point: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(() => beginWorkflowEvidence({
      workflow,
      journey: 'journeys/reparse-retention.journey.js',
      iteration: 4,
      binaryPath: binary,
      startedAt: '2026-08-26T01:00:04.000Z',
    }), /redirected|unknown directory|link or reparse/u,
    'pre-publication retention must refuse a redirected prior attempt before creating another one');
    assert.equal(readFileSync(sentinel, 'utf8'), 'must survive');
    assert.equal(existsSync(attempts[0].directory), true, 'retention mutated before validation finished');
    assert.equal(readdirSync(join(workflowDirectory, 'attempts')).length, 3,
      'a refused pre-retention pass still published another attempt');
  } finally {
    rmSync(workflowDirectory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('retention resumes a journal-authorized partial quarantine and preserves latest-success', () => {
  const workflow = workflowForTest('partial-quarantine-recovery');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-partial-quarantine-'));
  const binary = join(scratch, 'osg-e2e.exe');
  writeFileSync(binary, 'guarded');
  const create = (ordinal, outcome) => {
    const attempt = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/partial-quarantine.journey.js',
      iteration: ordinal,
      binaryPath: binary,
      startedAt: `2026-08-26T02:00:0${ordinal}.000Z`,
    });
    if (outcome !== 'running') {
      finalizeWorkflowEvidence({
        workflow,
        attemptId: attempt.id,
        outcome,
        exitStatus: outcome === 'pass' ? 0 : 1,
        failure: outcome === 'fail' ? `failure ${ordinal}` : null,
      });
    }
    return attempt;
  };
  try {
    const latestSuccess = create(1, 'pass');
    const removal = create(2, 'fail');
    const third = create(3, 'fail');
    const fourth = create(4, 'fail');
    const fifth = create(5, 'running');
    const fifthManifestPath = join(fifth.directory, 'manifest.json');
    const fifthManifest = JSON.parse(readFileSync(fifthManifestPath, 'utf8'));
    fifthManifest.attempt.outcome = 'fail';
    fifthManifest.attempt.endedAt = '2026-08-26T02:00:15.000Z';
    fifthManifest.attempt.exitStatus = 1;
    fifthManifest.attempt.failure = 'simulated process death after final manifest publication';
    writeFileSync(fifthManifestPath, `${JSON.stringify(fifthManifest, null, 2)}\n`);

    const trashRoot = join(workflowDirectory, '.osg-workflow-evidence-trash');
    const trashName = `${removal.id}.abcdef123456`;
    const quarantined = join(trashRoot, trashName);
    const journalPath = join(workflowDirectory, '.osg-workflow-evidence-retention.json');
    const journal = {
      schemaVersion: 1,
      publisher: 'osg-e2e-workflow-evidence',
      workflow,
      latestSuccessAttemptId: latestSuccess.id,
      operations: [{
        attemptId: removal.id,
        sourceName: removal.id,
        trashName,
        allowedFiles: ['README.md', 'manifest.json'],
      }],
    };
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    mkdirSync(trashRoot);
    renameSync(removal.directory, quarantined);
    rmSync(join(quarantined, 'README.md'));

    assert.deepEqual(applyWorkflowEvidenceRetention(workflow), { retained: 4, removed: 0 });
    assert.equal(existsSync(quarantined), false, 'partial quarantine was not recovered');
    assert.equal(existsSync(journalPath), false, 'completed recovery retained its authorization');
    assert.equal(existsSync(trashRoot), false, 'completed recovery retained empty trash');
    assert.equal(existsSync(latestSuccess.directory), true, 'latest-success proof was removed');
    assert.deepEqual(
      [third, fourth, fifth].map(({ directory }) => existsSync(directory)),
      [true, true, true],
    );
    const pointer = JSON.parse(readFileSync(join(workflowDirectory, 'latest-success.json'), 'utf8'));
    assert.equal(pointer.attemptId, latestSuccess.id);
  } finally {
    rmSync(workflowDirectory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('retention removes only exact publisher atomic sidecars and rejects malformed lookalikes', () => {
  const workflow = workflowForTest('atomic-sidecar-recovery');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-atomic-sidecar-'));
  const binary = join(scratch, 'osg-e2e.exe');
  writeFileSync(binary, 'guarded');
  try {
    const attempt = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/atomic-sidecar.journey.js',
      iteration: 1,
      binaryPath: binary,
    });
    finalizeWorkflowEvidence({
      workflow,
      attemptId: attempt.id,
      outcome: 'fail',
      exitStatus: 1,
    });
    const exact = join(attempt.directory, '.README.md.1234.abcdef123456.tmp');
    writeFileSync(exact, 'orphaned complete atomic replacement');
    assert.deepEqual(applyWorkflowEvidenceRetention(workflow), { retained: 1, removed: 0 });
    assert.equal(existsSync(exact), false);

    const manifestPath = join(attempt.directory, 'manifest.json');
    const replacementManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    replacementManifest.attempt.failure = 'the complete sidecar is newer than the durable manifest';
    const manifestSidecar = join(attempt.directory, '.manifest.json.1234.123456abcdef.tmp');
    writeFileSync(manifestSidecar, `${JSON.stringify(replacementManifest, null, 2)}\n`);
    applyWorkflowEvidenceRetention(workflow);
    assert.equal(existsSync(manifestSidecar), false);
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).attempt.failure,
      replacementManifest.attempt.failure);

    const newerSuccess = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/atomic-sidecar.journey.js',
      iteration: 2,
      binaryPath: binary,
      startedAt: '2026-08-26T03:00:02.000Z',
    });
    const newerManifestPath = join(newerSuccess.directory, 'manifest.json');
    const newerManifest = JSON.parse(readFileSync(newerManifestPath, 'utf8'));
    newerManifest.attempt.outcome = 'pass';
    newerManifest.attempt.endedAt = '2026-08-26T03:00:12.000Z';
    newerManifest.attempt.exitStatus = 0;
    writeFileSync(newerManifestPath, `${JSON.stringify(newerManifest, null, 2)}\n`);
    const currentPointerPath = join(workflowDirectory, 'latest-success.json');
    const newerPointer = {
      schemaVersion: 1,
      workflow,
      attemptId: newerSuccess.id,
      path: `attempts/${newerSuccess.id}`,
      endedAt: newerManifest.attempt.endedAt,
      commit: newerManifest.provenance.source.commit,
      tree: newerManifest.provenance.source.tree,
      dirty: newerManifest.provenance.source.dirty,
      binarySha256: newerManifest.provenance.binary.sha256,
    };
    const pointerSidecar = join(workflowDirectory,
      '.latest-success.json.1234.fedcba654321.tmp');
    writeFileSync(pointerSidecar, `${JSON.stringify(newerPointer, null, 2)}\n`);
    applyWorkflowEvidenceRetention(workflow);
    assert.equal(existsSync(pointerSidecar), false);
    assert.equal(JSON.parse(readFileSync(currentPointerPath, 'utf8')).attemptId, newerSuccess.id);

    const malformed = join(workflowDirectory,
      '..osg-workflow-evidence-retention.json.not-a-pid.abcdef123456.tmp');
    writeFileSync(malformed, 'foreign');
    assert.throws(() => applyWorkflowEvidenceRetention(workflow), /unknown retention-journal sidecar/u);
    assert.equal(readFileSync(malformed, 'utf8'), 'foreign');
  } finally {
    rmSync(workflowDirectory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('legacy evidence reset starts another confined attempt without deleting success', () => {
  const workflow = workflowForTest('reset');
  const root = workflowEvidenceDirectory(workflow);
  const priorAttempt = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  try {
    const first = resetWorkflowEvidence(workflow);
    const second = resetWorkflowEvidence(workflow);
    const inside = relative(resolve(WORKFLOW_EVIDENCE_ROOT), resolve(second));
    assert.ok(inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`));
    assert.notEqual(first, second);
    assert.equal(existsSync(first), true);
    assert.equal(existsSync(second), true);
    const legacyManifest = JSON.parse(readFileSync(join(second, 'manifest.json'), 'utf8'));
    assert.equal(legacyManifest.provenance.applicationHash, null);
    assert.throws(() => workflowEvidenceDirectory('../outside'), /bounded slug/);
  } finally {
    if (priorAttempt === undefined) delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    else process.env.OSG_E2E_EVIDENCE_ATTEMPT = priorAttempt;
    rmSync(root, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});
