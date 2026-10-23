// Hard-kill recovery of attempt creation and checkpoints, and refusal of transaction lookalikes.

import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  applyWorkflowEvidenceRetention, beginWorkflowEvidence,
  refreshWorkflowEvidenceIndex, workflowEvidenceDirectory, cleanupWorkflowEvidenceTestRoot,
  workflowForTest, workflowEvidenceModuleUrl, fixedProvenance, runEvidenceCrashChild,
} from './workflowEvidenceTestHarness.js';

test.after(cleanupWorkflowEvidenceTestRoot);
test('repeated owner deaths stay bounded because each new attempt prunes stale running attempts first', () => {
  const workflow = workflowForTest('pre-begin-running-retention');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  const attemptsDirectory = join(workflowDirectory, 'attempts');
  const attempts = [];
  try {
    for (let ordinal = 1; ordinal <= 9; ordinal += 1) {
      attempts.push(beginWorkflowEvidence({
        workflow,
        journey: 'journeys/crashed-owner.journey.js',
        iteration: ordinal,
        provenance: fixedProvenance(),
        startedAt: `2026-08-26T04:00:${String(ordinal).padStart(2, '0')}.000Z`,
      }));
      assert.ok(readdirSync(attemptsDirectory).length <= 4,
        'a crash-only sequence grew beyond retained attempts plus the active publication');
    }
    assert.equal(existsSync(attempts[0].directory), false,
      'the oldest stale running attempt survived repeated lease reacquisition');
    assert.equal(readdirSync(attemptsDirectory).length, 4);
    assert.deepEqual(applyWorkflowEvidenceRetention(workflow), { retained: 3, removed: 1 });
    assert.equal(readdirSync(attemptsDirectory).length, 3);
  } finally {
    rmSync(workflowDirectory, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('hard-killed attempt creation leaves only exact private temporaries that the next owner retires', () => {
  const boundaries = [
    ['begin-after-journal', false],
    ['begin-after-directory', false],
    ['begin-after-manifest', false],
    ['begin-before-publish', false],
    ['begin-after-publish', true],
  ];
  for (const [crashPoint, committed] of boundaries) {
    const workflow = workflowForTest(`begin-crash-${crashPoint.replaceAll('-', '')}`);
    const workflowDirectory = workflowEvidenceDirectory(workflow);
    try {
      const result = runEvidenceCrashChild({
        crashPoint,
        source: `
          const { beginWorkflowEvidence } = await import(${JSON.stringify(workflowEvidenceModuleUrl)});
          beginWorkflowEvidence({
            workflow: ${JSON.stringify(workflow)},
            journey: 'journeys/killed-begin.journey.js',
            iteration: 1,
            provenance: ${JSON.stringify(fixedProvenance())},
          });
        `,
      });
      assert.notEqual(result.status, 0,
        `evidence crash child unexpectedly survived ${crashPoint}: ${result.stderr}`);
      const attemptsDirectory = join(workflowDirectory, 'attempts');
      applyWorkflowEvidenceRetention(workflow);
      const finalAttempts = readdirSync(attemptsDirectory)
        .filter(name => /^\d{17}-\d{1,10}-[0-9a-f]{8}$/u.test(name));
      assert.equal(finalAttempts.length, committed ? 1 : 0,
        `${crashPoint} recovered a half-published attempt`);
      assert.equal(readdirSync(attemptsDirectory)
        .some(name => name.startsWith('.osg-attempt-')), false,
      'the next owner retained an authorized attempt publication residue');
      if (committed) {
        const directory = join(attemptsDirectory, finalAttempts[0]);
        assert.equal(existsSync(join(directory, 'manifest.json')), true);
        assert.equal(existsSync(join(directory, 'README.md')), true);
      }
    } finally {
      rmSync(workflowDirectory, { recursive: true, force: true });
      refreshWorkflowEvidenceIndex();
    }
  }
});

test('hard-killed checkpoints recover to either the complete prior or complete committed inventory', () => {
  const boundaries = [
    ['checkpoint-after-allocation-journal', false],
    ['checkpoint-after-payload-stage', false],
    ['checkpoint-after-journal', true],
    ['checkpoint-after-payload-publish', true],
    ['checkpoint-after-manifest', true],
    ['checkpoint-after-readme', true],
  ];
  for (const [crashPoint, committed] of boundaries) {
    const workflow = workflowForTest(`checkpoint-crash-${crashPoint.replaceAll('-', '')}`);
    const workflowDirectory = workflowEvidenceDirectory(workflow);
    const priorAttempt = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    try {
      const attempt = beginWorkflowEvidence({
        workflow,
        journey: 'journeys/killed-checkpoint.journey.js',
        iteration: 1,
        provenance: fixedProvenance(),
      });
      const result = runEvidenceCrashChild({
        crashPoint,
        source: `
          const { Buffer } = await import('node:buffer');
          const { writeFileSync } = await import('node:fs');
          const { captureWorkflowStep } = await import(${JSON.stringify(workflowEvidenceModuleUrl)});
          process.env.OSG_E2E_EVIDENCE_ATTEMPT = ${JSON.stringify(attempt.id)};
          globalThis.browser = {
            execute: async () => ({
              viewport: [1280, 720], document: [1280, 720],
              horizontalOverflow: false, horizontalOverflowPx: 0,
              horizontalScroll: { window: 0, document: 0, body: 0 },
              errorAlerts: [], errorToasts: [], alerts: [], toasts: [],
              visibleText: 'transaction checkpoint'
            }),
            pause: async () => {},
            takeScreenshot: async () => Buffer.alloc(2048, 0x5a).toString('base64'),
          };
          await captureWorkflowStep({
            workflow: ${JSON.stringify(workflow)},
            step: 'transaction-checkpoint',
            description: 'A checkpoint interrupted at a controlled owner-death boundary.',
          });
        `,
      });
      assert.notEqual(result.status, 0,
        `checkpoint crash child unexpectedly survived ${crashPoint}: ${result.stderr}`);
      applyWorkflowEvidenceRetention(workflow);
      const manifest = JSON.parse(readFileSync(join(attempt.directory, 'manifest.json'), 'utf8'));
      const screenshot = join(attempt.directory, 'transaction-checkpoint.png');
      assert.equal(manifest.steps.length, committed ? 1 : 0,
        `${crashPoint} recovered a half-published checkpoint manifest`);
      assert.equal(existsSync(screenshot), committed,
        `${crashPoint} recovered a half-published checkpoint payload`);
      assert.equal(existsSync(join(attempt.directory, '.osg-evidence-operation.json')), false);
      assert.equal(readdirSync(attempt.directory)
        .some(name => name.startsWith('.osg-evidence-payload-')), false);
      const readme = readFileSync(join(attempt.directory, 'README.md'), 'utf8');
      assert.equal(readme.includes('transaction-checkpoint.png'), committed,
        `${crashPoint} recovered a README from a different transaction state`);
    } finally {
      if (priorAttempt === undefined) delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
      else process.env.OSG_E2E_EVIDENCE_ATTEMPT = priorAttempt;
      rmSync(workflowDirectory, { recursive: true, force: true });
      refreshWorkflowEvidenceIndex();
    }
  }
});

test('recovery rejects malformed transaction lookalikes and unknown final files without mutation', () => {
  const workflow = workflowForTest('transaction-lookalike-refusal');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  try {
    const attempt = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/transaction-lookalike.journey.js',
      iteration: 1,
      provenance: fixedProvenance(),
    });
    const lookalike = join(attempt.directory, '.osg-evidence-payload-not-owned-0.tmp');
    const unknown = join(attempt.directory, 'unclaimed-final.png');
    writeFileSync(lookalike, 'foreign lookalike');
    writeFileSync(unknown, 'foreign final');
    assert.throws(() => applyWorkflowEvidenceRetention(workflow), /unknown operation payload/u);
    assert.equal(readFileSync(lookalike, 'utf8'), 'foreign lookalike');
    assert.equal(readFileSync(unknown, 'utf8'), 'foreign final');
    rmSync(lookalike);
    assert.throws(() => applyWorkflowEvidenceRetention(workflow), /unknown file: unclaimed-final\.png/u);
    assert.equal(readFileSync(unknown, 'utf8'), 'foreign final');
    rmSync(unknown);
    const exact = join(attempt.directory, `.osg-evidence-payload-${'b'.repeat(32)}-0.tmp`);
    writeFileSync(exact, 'foreign exact payload');
    assert.throws(() => applyWorkflowEvidenceRetention(workflow), /unjournaled exact operation payload/u);
    assert.equal(readFileSync(exact, 'utf8'), 'foreign exact payload');
    const partialJournal = join(attempt.directory,
      '..osg-evidence-operation.json.1234.abcdef123456.tmp');
    writeFileSync(partialJournal, '{"schemaVersion":');
    assert.throws(() => applyWorkflowEvidenceRetention(workflow), /unjournaled exact operation payload/u);
    assert.equal(readFileSync(exact, 'utf8'), 'foreign exact payload');
    assert.equal(existsSync(partialJournal), false,
      'an incomplete unpublished journal sidecar was treated as allocation authority');
  } finally {
    rmSync(workflowDirectory, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('an exact-shaped attempt temporary without a durable parent journal is foreign and preserved', () => {
  const workflow = workflowForTest('exact-attempt-temp-refusal');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  const attemptsDirectory = join(workflowDirectory, 'attempts');
  const attemptId = `20260826050505000-${process.pid}-deadbeef`;
  const temporary = join(attemptsDirectory, `.osg-attempt-${attemptId}-${'c'.repeat(24)}.tmp`);
  const sentinel = join(temporary, 'foreign.txt');
  try {
    mkdirSync(temporary, { recursive: true });
    writeFileSync(sentinel, 'must survive');
    assert.throws(() => applyWorkflowEvidenceRetention(workflow),
      /unjournaled attempt publication temporary/u);
    assert.equal(readFileSync(sentinel, 'utf8'), 'must survive');
  } finally {
    rmSync(workflowDirectory, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});
