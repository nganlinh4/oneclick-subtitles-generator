import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { URL } from 'node:url';

const workflowEvidenceTestRoot = mkdtempSync(join(tmpdir(), 'osg-workflow-evidence-test-'));
const priorEvidenceRoot = process.env.OSG_E2E_WORKFLOW_EVIDENCE_ROOT;
process.env.OSG_E2E_WORKFLOW_EVIDENCE_ROOT = workflowEvidenceTestRoot;

const {
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
  validateVisibleState,
  workflowEvidenceDirectory,
  workflowFailureStepForTest,
  workflowNameForJourney,
} = await import('./workflowEvidence.js');

test.after(() => {
  if (priorEvidenceRoot === undefined) delete process.env.OSG_E2E_WORKFLOW_EVIDENCE_ROOT;
  else process.env.OSG_E2E_WORKFLOW_EVIDENCE_ROOT = priorEvidenceRoot;
  rmSync(workflowEvidenceTestRoot, { recursive: true, force: true });
});

const workflowForTest = (name) => `contract-${name}-${process.pid}`;
const workflowEvidenceModuleUrl = new URL('./workflowEvidence.js', import.meta.url).href;
const fixedProvenance = () => ({
  source: {
    commit: 'a'.repeat(40), dirty: false, dirtyEntries: [], dirtyEntriesTruncated: false,
  },
  binary: { path: resolve('osg-e2e-test.exe'), exists: false, sha256: null, size: null },
});

const runEvidenceCrashChild = ({ crashPoint, source }) => spawnSync(
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

test('derives stable readable workflow folders from journey file names', () => {
  assert.equal(workflowNameForJourney('journeys/nativeExportDecoded.journey.js'), 'native-export-decoded');
  assert.equal(workflowNameForJourney('urlToPreview.journey.js'), 'url-to-preview');
});

test('derives bounded collision-resistant failure steps from arbitrary test titles', () => {
  const longTitle = `${'A title_with punctuation ! '.repeat(20)}first`;
  const first = workflowFailureStepForTest(longTitle);
  const second = workflowFailureStepForTest(`${longTitle} second`);
  assert.match(first, /^failure-[a-z0-9-]+-[0-9a-f]{8}$/);
  assert.ok(first.length <= 80);
  assert.ok(second.length <= 80);
  assert.notEqual(first, second, 'truncated titles need a digest so their evidence cannot collide');
  assert.match(workflowFailureStepForTest('___'), /^failure-test-[0-9a-f]{8}$/);
});

test('bounds and redacts hostile WebdriverIO errors while retaining exact useful identity and stack', () => {
  const credential = 'AIzaSyThisMustNeverEnterImmutableEvidence123456';
  const bearer = 'header-secret-that-must-not-survive';
  const record = boundedWorkflowTestFailure({
    test: {
      title: 'renders the edited cue at 00:01.250',
      parent: 'native subtitle journey',
      file: 'journeys/nativeSubtitle.journey.js',
      uid: 'spec-17',
    },
    error: {
      name: 'AssertionError',
      message: `pixel mismatch https://provider.invalid/frame?api_key=${credential}&frame=42 Authorization: Bearer ${bearer} GEMINI_API_KEY=${credential}`,
      stack: `AssertionError: exact pixel mismatch\n    at assertFrame (oracle.js:42:7)\n${'x'.repeat(40_000)}`,
    },
    capturedAt: '2026-08-26T00:00:00.000Z',
  });
  assert.equal(record.test.title, 'renders the edited cue at 00:01.250');
  assert.equal(record.error.name, 'AssertionError');
  assert.match(record.error.message, /api_key=\[REDACTED\]/u);
  assert.match(record.error.message, /Authorization: \[REDACTED\]/u);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(`${credential}|${bearer}`, 'u'));
  assert.match(record.error.stack, /at assertFrame \(oracle\.js:42:7\)/u);
  assert.ok(record.error.stack.length <= 16 * 1024);
  assert.equal(record.truncated.stack, true);
});

test('persists failed test details before WebView capture and preserves them through exit finalization', () => {
  const workflow = workflowForTest('test-failure-record');
  const root = workflowEvidenceDirectory(workflow);
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-test-failure-'));
  const binary = join(scratch, 'osg-e2e.exe');
  const priorAttempt = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  writeFileSync(binary, 'guarded');
  try {
    const attempt = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/failing.journey.js',
      iteration: 1,
      binaryPath: binary,
    });
    process.env.OSG_E2E_EVIDENCE_ATTEMPT = attempt.id;
    const recorded = recordWorkflowTestFailure({
      workflow,
      test: { title: 'rejects a stale frame', parent: 'native preview', file: 'failing.js' },
      error: {
        name: 'AssertionError',
        message: 'expected frame 18, received frame 17',
        stack: 'AssertionError: expected frame 18, received frame 17\n    at failing.js:91:5',
      },
      capturedAt: '2026-08-26T00:01:00.000Z',
    });
    assert.equal(recorded.test.title, 'rejects a stale frame');
    const finalized = finalizeWorkflowEvidence({
      workflow,
      attemptId: attempt.id,
      outcome: 'fail',
      exitStatus: 1,
      failure: null,
      endedAt: '2026-08-26T00:02:00.000Z',
    });
    assert.match(finalized.attempt.failure, /rejects a stale frame/u);
    assert.match(finalized.attempt.failure, /expected frame 18, received frame 17/u);
    const diagnostic = finalized.diagnostics.find(({ name }) => name === 'test-failures');
    assert.deepEqual(diagnostic?.file, 'diagnostics/test-failures.json');
    const document = JSON.parse(readFileSync(join(attempt.directory, diagnostic.file), 'utf8'));
    assert.equal(document.failures.length, 1);
    assert.equal(document.failures[0].error.stack,
      'AssertionError: expected frame 18, received frame 17\n    at failing.js:91:5');
  } finally {
    if (priorAttempt === undefined) delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    else process.env.OSG_E2E_EVIDENCE_ATTEMPT = priorAttempt;
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('failed finalization never leaves a null failure when no test hook ran', () => {
  const workflow = workflowForTest('failure-fallback');
  const root = workflowEvidenceDirectory(workflow);
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-failure-fallback-'));
  const binary = join(scratch, 'osg-e2e.exe');
  writeFileSync(binary, 'guarded');
  try {
    const attempt = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/session-setup-failure.journey.js',
      iteration: 1,
      binaryPath: binary,
    });
    const finalized = finalizeWorkflowEvidence({
      workflow,
      attemptId: attempt.id,
      outcome: 'fail',
      exitStatus: 1,
    });
    assert.match(finalized.attempt.failure, /failed with exit status 1 before its test hook/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('the WDIO hook records the Error before attempting renderer-dependent evidence', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'wdio.conf.js'), 'utf8');
  assert.match(source, /afterTest\(test, context, \{ error, passed \}\)/u);
  const record = source.indexOf('recordWorkflowTestFailure({ workflow, test, error })');
  const screenshot = source.indexOf('await browser.saveScreenshot(fallbackScreenshot)');
  const promotion = source.indexOf('await promoteWorkflowFailureEvidence({');
  assert.ok(record >= 0, 'the failure hook drops the WebdriverIO Error object');
  assert.ok(record < screenshot && screenshot < promotion,
    'structured failure persistence must precede renderer-dependent screenshot diagnostics');
  assert.match(source,
    /afterHook: \(test, context, \{ error, passed \}, hookName\)[\s\S]*recordWorkflowTestFailure\(\{ workflow, test: \{ \.\.\.test, hook: hookName \}, error \}\)/u,
    'suite/root hook failures must retain their exact Error even when no test body runs');
});

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
    assert.throws(() => workflowEvidenceDirectory('../outside'), /bounded slug/);
  } finally {
    if (priorAttempt === undefined) delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    else process.env.OSG_E2E_EVIDENCE_ATTEMPT = priorAttempt;
    rmSync(root, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('visible errors and horizontal overflow fail unless exactly and narrowly documented', () => {
  const state = {
    errorAlerts: ['Preview failed: unreadable media'],
    errorToasts: ['Export failed: disk full'],
    horizontalOverflow: true,
    horizontalOverflowPx: 3,
    horizontalScroll: { window: 0, document: 0, body: 0 },
  };
  assert.throws(() => validateVisibleState(state), /visible error alert/);
  assert.doesNotThrow(() => validateVisibleState(state, {
    errorAlerts: [{
      text: 'Preview failed: unreadable media',
      reason: 'This journey proves the explicit damaged-media refusal.',
    }],
    errorToasts: [{
      text: 'Export failed: disk full',
      reason: 'This journey proves the explicit no-space refusal.',
    }],
    horizontalOverflow: {
      maxPixels: 3,
      reason: 'This fixture deliberately measures a three-pixel browser rounding edge.',
    },
  }));
  assert.throws(() => validateVisibleState(state, {
    errorAlerts: [{ text: 'Preview failed', reason: 'Substring matching is deliberately forbidden.' }],
  }), /visible error alert/);
  assert.throws(() => validateVisibleState({
    errorAlerts: [], errorToasts: [], horizontalOverflowPx: 17,
    horizontalScroll: { window: 0, document: 0, body: 0 },
  }, {
    horizontalOverflow: { maxPixels: 17, reason: 'This should be too broad to admit.' },
  }), /1\.\.16px/);
});

test('zero overflow cannot hide a horizontally displaced document', () => {
  const settled = {
    errorAlerts: [],
    errorToasts: [],
    horizontalOverflow: false,
    horizontalOverflowPx: 0,
    horizontalScroll: { window: 0, document: 0, body: 0 },
  };
  assert.doesNotThrow(() => validateVisibleState({
    ...settled,
    // Nested product scrollers are intentionally outside the root-scroll contract.
    details: { timelineScrollLeft: 840, tabStripScrollLeft: 320 },
  }));
  for (const [root, offset] of [
    ['window', 11],
    ['document', 11],
    ['body', -0.25],
  ]) {
    assert.throws(() => validateVisibleState({
      ...settled,
      horizontalScroll: { ...settled.horizontalScroll, [root]: offset },
      // This reproduces the Settings failure shape: the modal and document were displaced even
      // though scrollWidth equalled innerWidth. The Settings oracle separately checks the modal.
      details: { modalScrollLeft: 11 },
    }), /rests at nonzero horizontal document scroll/);
  }
  assert.throws(() => validateVisibleState({
    ...settled,
    horizontalScroll: { window: 0, document: Number.POSITIVE_INFINITY, body: 0 },
  }), /invalid document horizontal scroll offset/);
  assert.throws(() => validateVisibleState({
    ...settled,
    horizontalScroll: undefined,
  }), /must record bounded window\/document\/body/);
});

test('visible state records bounded root offsets even when the document width equals the viewport', () => {
  const priorDocument = globalThis.document;
  const priorWindow = globalThis.window;
  const priorGetComputedStyle = globalThis.getComputedStyle;
  globalThis.document = {
    documentElement: {
      scrollWidth: 1_440,
      scrollHeight: 900,
      scrollLeft: 5_000_000,
    },
    body: {
      innerText: 'settled editor',
      scrollLeft: -5_000_000,
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.window = {
    innerWidth: 1_440,
    innerHeight: 900,
    scrollX: 7.5,
  };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  try {
    const state = collectVisibleStateFromPage();
    assert.equal(state.horizontalOverflowPx, 0);
    assert.deepEqual(state.horizontalScroll, {
      window: 7.5,
      document: 1_000_000,
      body: -1_000_000,
    });
    assert.throws(() => validateVisibleState(state), /rests at nonzero horizontal document scroll/);
  } finally {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
    if (priorGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = priorGetComputedStyle;
  }
});

test('evidence focus scrolling never moves Settings and still centers off-screen page evidence', async () => {
  const workflow = workflowForTest('focus-scroll');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-focus-scroll-'));
  const binary = join(scratch, 'osg-e2e.exe');
  const priorAttempt = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  const priorBrowser = globalThis.browser;
  const scrolls = [];
  const rectangles = [
    { top: 100, right: 1_300, bottom: 800, left: 100 },
    { top: 950, right: 1_300, bottom: 1_200, left: 100 },
    { top: 950, right: 1_300, bottom: 1_200, left: 100 },
  ];
  writeFileSync(binary, 'guarded');
  try {
    const attempt = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/focus-scroll.journey.js',
      iteration: 1,
      binaryPath: binary,
    });
    process.env.OSG_E2E_EVIDENCE_ATTEMPT = attempt.id;
    globalThis.browser = {
      execute: async (callback, selector) => {
        if (selector !== undefined) {
          const rect = rectangles.shift();
          const insideSettingsModal = selector === '.settings-modal'
            || selector === '.video-processing-section';
          const priorDocument = globalThis.document;
          const priorWindow = globalThis.window;
          globalThis.document = {
            querySelector: () => ({
              closest: (candidate) => (
                candidate === '.settings-modal' && insideSettingsModal ? {} : null
              ),
              getBoundingClientRect: () => rect,
              scrollIntoView: (options) => scrolls.push(options),
            }),
          };
          globalThis.window = { innerWidth: 1_440, innerHeight: 900 };
          try {
            return callback(selector);
          } finally {
            globalThis.document = priorDocument;
            globalThis.window = priorWindow;
          }
        }
        return {
          viewport: [1_440, 900],
          document: [1_440, 900],
          horizontalOverflow: false,
          horizontalOverflowPx: 0,
          horizontalScroll: { window: 0, document: 0, body: 0 },
          errorAlerts: [],
          errorToasts: [],
          alerts: [],
          toasts: [],
          visibleText: 'settled settings surface',
        };
      },
      pause: async () => {},
      takeScreenshot: async () => Buffer.alloc(2_000).toString('base64'),
    };
    await captureWorkflowStep({
      workflow,
      step: 'visible-fixed-surface',
      description: 'A fixed settings surface already inside the viewport stays in place.',
      focusSelector: '.settings-modal',
    });
    assert.deepEqual(scrolls, []);
    await assert.rejects(() => captureWorkflowStep({
      workflow,
      step: 'off-screen-modal-descendant',
      description: 'Capture refuses to claim a Settings target that the screenshot cannot show.',
      focusSelector: '.video-processing-section',
    }), /outside the visible Settings viewport/u);
    assert.deepEqual(scrolls, [], 'a Settings descendant must never mutate modal or page scroll');
    await captureWorkflowStep({
      workflow,
      step: 'off-screen-surface',
      description: 'An off-screen surface is brought immediately into the evidence frame.',
      focusSelector: '.below-fold',
    });
    assert.deepEqual(scrolls, [{ behavior: 'instant', block: 'center', inline: 'nearest' }]);
  } finally {
    globalThis.browser = priorBrowser;
    if (priorAttempt === undefined) delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    else process.env.OSG_E2E_EVIDENCE_ATTEMPT = priorAttempt;
    rmSync(workflowDirectory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('independent artifacts and customer screenshots cannot share a manifest name or file', async () => {
  const workflow = workflowForTest('artifact-screenshot-collision');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-collision-'));
  const binary = join(scratch, 'osg-e2e.exe');
  const nativeFrame = join(scratch, 'native-frame.png');
  const nativeBytes = Buffer.alloc(2_000, 0x11);
  const screenshotBytes = Buffer.alloc(2_400, 0x22);
  const priorAttempt = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  const priorBrowser = globalThis.browser;
  writeFileSync(binary, 'guarded');
  writeFileSync(nativeFrame, nativeBytes);
  try {
    const attempt = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/artifact-screenshot-collision.journey.js',
      iteration: 1,
      binaryPath: binary,
    });
    process.env.OSG_E2E_EVIDENCE_ATTEMPT = attempt.id;
    globalThis.browser = {
      execute: async () => ({
        viewport: [1_400, 900],
        document: [1_400, 900],
        horizontalOverflow: false,
        horizontalOverflowPx: 0,
        horizontalScroll: { window: 0, document: 0, body: 0 },
        errorAlerts: [],
        errorToasts: [],
        alerts: [],
        toasts: [],
        visibleText: 'settled customer surface',
      }),
      pause: async () => {},
      takeScreenshot: async () => screenshotBytes.toString('base64'),
    };

    const artifactPath = copyWorkflowArtifact({
      workflow,
      name: '04-font-size-native-frame',
      source: nativeFrame,
      description: 'Independent 716x537 native compositor crop.',
    });
    await assert.rejects(() => captureWorkflowStep({
      workflow,
      step: '04-font-size-native-frame',
      description: 'This page screenshot must not overwrite the native frame.',
    }), /collides with independent artifact/u);
    const manifestPath = join(attempt.directory, 'manifest.json');
    const caseVariantManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    caseVariantManifest.artifacts[0].name = '04-FONT-SIZE-NATIVE-FRAME';
    caseVariantManifest.artifacts[0].file = '04-FONT-SIZE-NATIVE-FRAME.PNG';
    writeFileSync(manifestPath, `${JSON.stringify(caseVariantManifest, null, 2)}\n`);
    await assert.rejects(() => captureWorkflowStep({
      workflow,
      step: '04-font-size-native-frame',
      description: 'Windows case folding must not bypass a legacy manifest collision.',
    }), /collides with independent artifact/u);
    caseVariantManifest.artifacts[0].name = '04-font-size-native-frame';
    caseVariantManifest.artifacts[0].file = '04-font-size-native-frame.png';
    writeFileSync(manifestPath, `${JSON.stringify(caseVariantManifest, null, 2)}\n`);
    assert.deepEqual(readFileSync(artifactPath), nativeBytes, 'the rejected screenshot overwrote the artifact');

    await captureWorkflowStep({
      workflow,
      step: '04-font-size-control-applied',
      description: 'The customer-visible control after the native frame changed.',
    });
    const originalScreenshot = readFileSync(join(attempt.directory, '04-font-size-control-applied.png'));
    globalThis.browser.takeScreenshot = async () => Buffer.alloc(2_400, 0x7f).toString('base64');
    await assert.rejects(() => captureWorkflowStep({
      workflow,
      step: '04-font-size-control-applied',
      description: 'A duplicate checkpoint must not replace its first screenshot.',
    }), /collides with existing customer screenshot/u);
    assert.deepEqual(
      readFileSync(join(attempt.directory, '04-font-size-control-applied.png')),
      originalScreenshot,
      'duplicate checkpoint overwrote immutable screenshot bytes',
    );
    assert.throws(() => copyWorkflowArtifact({
      workflow,
      name: '04-font-size-control-applied',
      source: nativeFrame,
      description: 'This artifact must not reuse a screenshot name.',
    }), /collides with customer screenshot/u);
    const screenshotCaseManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    screenshotCaseManifest.steps[0].step = '04-FONT-SIZE-CONTROL-APPLIED';
    screenshotCaseManifest.steps[0].screenshot = '04-FONT-SIZE-CONTROL-APPLIED.PNG';
    writeFileSync(manifestPath, `${JSON.stringify(screenshotCaseManifest, null, 2)}\n`);
    assert.throws(() => copyWorkflowArtifact({
      workflow,
      name: '04-font-size-control-applied',
      source: nativeFrame,
      description: 'Windows case folding must not bypass a legacy screenshot collision.',
    }), /collides with customer screenshot/u);
    screenshotCaseManifest.steps[0].step = '04-font-size-control-applied';
    screenshotCaseManifest.steps[0].screenshot = '04-font-size-control-applied.png';
    writeFileSync(manifestPath, `${JSON.stringify(screenshotCaseManifest, null, 2)}\n`);

    const manifest = JSON.parse(readFileSync(join(attempt.directory, 'manifest.json'), 'utf8'));
    assert.deepEqual(
      manifest.artifacts.map(({ name, file }) => [name, file]),
      [['04-font-size-native-frame', '04-font-size-native-frame.png']],
    );
    assert.deepEqual(
      manifest.steps.map(({ step, screenshot }) => [step, screenshot]),
      [['04-font-size-control-applied', '04-font-size-control-applied.png']],
    );
    assert.deepEqual(
      readFileSync(join(attempt.directory, '04-font-size-control-applied.png')),
      screenshotBytes,
    );
  } finally {
    globalThis.browser = priorBrowser;
    if (priorAttempt === undefined) delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    else process.env.OSG_E2E_EVIDENCE_ATTEMPT = priorAttempt;
    rmSync(workflowDirectory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('independent artifacts fail closed on duplicate and normalized collisions before copying', () => {
  const workflow = workflowForTest('artifact-artifact-collision');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-artifact-collision-'));
  const binary = join(scratch, 'osg-e2e.exe');
  const firstSource = join(scratch, 'first.png');
  const replacementSource = join(scratch, 'replacement.png');
  const distinctSource = join(scratch, 'distinct.jpg');
  const normalizedVariantSource = join(scratch, `variant.e\u0301`);
  const firstBytes = Buffer.alloc(2_000, 0x31);
  const replacementBytes = Buffer.alloc(2_000, 0x32);
  const distinctBytes = Buffer.alloc(2_000, 0x33);
  const normalizedVariantBytes = Buffer.alloc(2_000, 0x34);
  const priorAttempt = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  writeFileSync(binary, 'guarded');
  writeFileSync(firstSource, firstBytes);
  writeFileSync(replacementSource, replacementBytes);
  writeFileSync(distinctSource, distinctBytes);
  writeFileSync(normalizedVariantSource, normalizedVariantBytes);
  try {
    const attempt = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/artifact-artifact-collision.journey.js',
      iteration: 1,
      binaryPath: binary,
    });
    process.env.OSG_E2E_EVIDENCE_ATTEMPT = attempt.id;

    const firstPath = copyWorkflowArtifact({
      workflow,
      name: 'native-frame',
      source: firstSource,
      description: 'First independent compositor frame.',
    });
    const distinctPath = copyWorkflowArtifact({
      workflow,
      name: 'decoded-export',
      source: distinctSource,
      description: 'A genuinely distinct decoded export artifact.',
    });
    assert.deepEqual(readFileSync(firstPath), firstBytes);
    assert.deepEqual(readFileSync(distinctPath), distinctBytes);

    const orphanPath = join(attempt.directory, 'orphan.png');
    writeFileSync(orphanPath, firstBytes);
    assert.throws(() => copyWorkflowArtifact({
      workflow,
      name: 'orphan',
      source: replacementSource,
      description: 'An orphaned path must fail closed rather than be overwritten.',
    }), /path already exists outside its manifest/u);
    assert.deepEqual(readFileSync(orphanPath), firstBytes, 'orphaned evidence bytes were overwritten');

    assert.throws(() => copyWorkflowArtifact({
      workflow,
      name: 'native-frame',
      source: replacementSource,
      description: 'An exact duplicate must not replace the first artifact.',
    }), /collides with existing independent artifact/u);
    assert.deepEqual(readFileSync(firstPath), firstBytes, 'exact duplicate overwrote the first artifact');

    const manifestPath = join(attempt.directory, 'manifest.json');
    const caseVariantManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    caseVariantManifest.artifacts[0].name = 'CASE-VARIANT';
    writeFileSync(manifestPath, `${JSON.stringify(caseVariantManifest, null, 2)}\n`);
    assert.throws(() => copyWorkflowArtifact({
      workflow,
      name: 'case-variant',
      source: replacementSource,
      description: 'Case folding must reject a legacy manifest name variant.',
    }), /collides with existing independent artifact/u);

    caseVariantManifest.artifacts[0].name = 'native-frame';
    caseVariantManifest.artifacts[0].file = 'unicode-file.\u00c9';
    writeFileSync(manifestPath, `${JSON.stringify(caseVariantManifest, null, 2)}\n`);
    assert.throws(() => copyWorkflowArtifact({
      workflow,
      name: 'unicode-file',
      source: normalizedVariantSource,
      description: 'NFC plus case folding must reject canonically equivalent file variants.',
    }), /collides with existing independent artifact/u);
    assert.equal(
      existsSync(join(attempt.directory, `unicode-file.e\u0301`)),
      false,
      'the normalized collision was detected only after copying',
    );

    caseVariantManifest.artifacts[0].file = 'street-straße.png';
    writeFileSync(manifestPath, `${JSON.stringify(caseVariantManifest, null, 2)}\n`);
    assert.throws(() => copyWorkflowArtifact({
      workflow,
      name: 'street-strasse',
      source: replacementSource,
      description: 'A Unicode expansion fold must collide before any bytes are copied.',
    }), /collides with existing independent artifact/u);
    assert.equal(
      existsSync(join(attempt.directory, 'street-strasse.png')),
      false,
      'the full case-fold collision was detected only after copying',
    );

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.artifacts.length, 2, 'rejected collisions changed the artifact manifest');
    assert.deepEqual(readFileSync(firstPath), firstBytes);
    assert.deepEqual(readFileSync(distinctPath), distinctBytes);
  } finally {
    if (priorAttempt === undefined) delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    else process.env.OSG_E2E_EVIDENCE_ATTEMPT = priorAttempt;
    rmSync(workflowDirectory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('failure capture copies only bounded browser state and app-log tails', async () => {
  const workflow = workflowForTest('diagnostics');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-diagnostics-'));
  const binary = join(scratch, 'osg-e2e.exe');
  const logRoot = join(scratch, 'run');
  const logDirectory = join(logRoot, 'logs');
  const priorAttempt = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  const priorRunRoot = process.env.OSG_E2E_DATA_ROOT;
  const priorBrowser = globalThis.browser;
  writeFileSync(binary, 'guarded');
  mkdirSync(logDirectory, { recursive: true });
  writeFileSync(join(logDirectory, 'app.log'), `prefix\n${'x'.repeat(32 * 1024)}`);
  try {
    const attempt = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/failing.journey.js',
      iteration: 1,
      binaryPath: binary,
    });
    process.env.OSG_E2E_EVIDENCE_ATTEMPT = attempt.id;
    process.env.OSG_E2E_DATA_ROOT = logRoot;
    let executions = 0;
    globalThis.browser = {
      execute: async () => {
        executions += 1;
        if (executions === 1) return undefined;
        return {
          viewport: [1440, 900],
          document: [1440, 900],
          horizontalOverflow: false,
          horizontalOverflowPx: 0,
          horizontalScroll: { window: 0, document: 0, body: 0 },
          errorAlerts: [],
          errorToasts: [],
          alerts: [],
          toasts: [],
          visibleText: 'bounded failure state',
        };
      },
      pause: async () => {},
      takeScreenshot: async () => Buffer.alloc(2_000).toString('base64'),
      getUrl: async () => 'https://tauri.localhost/',
      getTitle: async () => 'OSG',
      getWindowRect: async () => ({ x: -10_000, y: 0, width: 1440, height: 900 }),
      getLogs: async () => Array.from({ length: 120 }, (_, index) => ({
        level: 'SEVERE',
        message: `${index}:${'m'.repeat(3_000)}`,
      })),
    };
    await captureWorkflowStep({
      workflow,
      step: 'failure-contract',
      description: 'Failure evidence from a simulated already-accessible WebView.',
    });
    const manifest = JSON.parse(readFileSync(join(attempt.directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.diagnostics.length, 2);
    const browserState = JSON.parse(readFileSync(
      join(attempt.directory, 'diagnostics', 'browser-state.json'),
      'utf8',
    ));
    assert.equal(browserState.browserLogs.length, 100);
    assert.equal(browserState.browserLogs.at(-1).message.length, 2_000);
    const appLogs = JSON.parse(readFileSync(
      join(attempt.directory, 'diagnostics', 'app-log-tails.json'),
      'utf8',
    ));
    assert.equal(appLogs.files.length, 1);
    assert.equal(appLogs.files[0].tailTruncated, true);
    assert.ok(Buffer.byteLength(appLogs.files[0].tail) <= 16 * 1024);
  } finally {
    globalThis.browser = priorBrowser;
    if (priorAttempt === undefined) delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    else process.env.OSG_E2E_EVIDENCE_ATTEMPT = priorAttempt;
    if (priorRunRoot === undefined) delete process.env.OSG_E2E_DATA_ROOT;
    else process.env.OSG_E2E_DATA_ROOT = priorRunRoot;
    rmSync(workflowDirectory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});

test('a pre-checkpoint failure promotes the fallback screenshot and diagnostics when page evaluation is broken', async () => {
  const workflow = workflowForTest('pre-checkpoint-failure');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-pre-checkpoint-'));
  const binary = join(scratch, 'osg-e2e.exe');
  const runRoot = join(scratch, 'run');
  const fallbackScreenshot = join(runRoot, 'evidence', 'failed-before-checkpoint.png');
  const fallbackBytes = Buffer.alloc(2_400, 0x5a);
  const priorAttempt = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  const priorRunRoot = process.env.OSG_E2E_DATA_ROOT;
  const priorBrowser = globalThis.browser;
  writeFileSync(binary, 'guarded');
  mkdirSync(join(runRoot, 'evidence'), { recursive: true });
  mkdirSync(join(runRoot, 'logs'), { recursive: true });
  writeFileSync(fallbackScreenshot, fallbackBytes);
  writeFileSync(join(runRoot, 'logs', 'app.log'), 'failure before the first checkpoint\n');
  try {
    const attempt = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/pre-checkpoint-failure.journey.js',
      iteration: 1,
      binaryPath: binary,
    });
    process.env.OSG_E2E_EVIDENCE_ATTEMPT = attempt.id;
    process.env.OSG_E2E_DATA_ROOT = runRoot;
    assert.deepEqual(attempt.manifest.steps, [], 'the contract must start before any checkpoint');
    globalThis.browser = {
      execute: async () => { throw new Error('WebView evaluation unavailable after failure'); },
      takeScreenshot: async () => { throw new Error('a second screenshot attempt must not be needed'); },
      getUrl: async () => { throw new Error('session ended'); },
      getTitle: async () => { throw new Error('session ended'); },
      getWindowRect: async () => { throw new Error('session ended'); },
      getLogs: async () => { throw new Error('session ended'); },
    };

    recordWorkflowTestFailure({
      workflow,
      test: { title: 'fails before its first checkpoint', parent: 'pre-checkpoint journey' },
      error: {
        name: 'AssertionError',
        message: 'the native frame never became ready',
        stack: 'AssertionError: the native frame never became ready\n    at journey.js:10:3',
      },
    });

    const result = await promoteWorkflowFailureEvidence({
      workflow,
      step: 'failure-before-first-checkpoint',
      description: 'The journey failed before it could record a deliberate checkpoint.',
      fallbackScreenshot,
    });

    assert.equal(result.screenshot, join(attempt.directory, 'failure-before-first-checkpoint.png'));
    assert.deepEqual(readFileSync(result.screenshot), fallbackBytes);
    const manifest = JSON.parse(readFileSync(join(attempt.directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.steps.length, 1);
    assert.equal(manifest.steps[0].details.emergencyCapture, true);
    assert.equal(manifest.steps[0].details.fallbackScreenshotImported, true);
    assert.match(manifest.steps[0].state.captureUnavailable, /WebView evaluation unavailable/);
    assert.deepEqual(manifest.diagnostics.map(({ name }) => name), [
      'app-log-tails',
      'browser-state',
      'test-failures',
    ], 'renderer diagnostics must not overwrite the already-captured test Error');
    assert.equal(existsSync(join(attempt.directory, 'diagnostics', 'browser-state.json')), true);
    const testFailures = JSON.parse(readFileSync(
      join(attempt.directory, 'diagnostics', 'test-failures.json'),
      'utf8',
    ));
    assert.match(testFailures.failures[0].error.stack, /at journey\.js:10:3/u);
    const appLogs = JSON.parse(readFileSync(
      join(attempt.directory, 'diagnostics', 'app-log-tails.json'),
      'utf8',
    ));
    assert.match(appLogs.files[0].tail, /failure before the first checkpoint/);
  } finally {
    globalThis.browser = priorBrowser;
    if (priorAttempt === undefined) delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    else process.env.OSG_E2E_EVIDENCE_ATTEMPT = priorAttempt;
    if (priorRunRoot === undefined) delete process.env.OSG_E2E_DATA_ROOT;
    else process.env.OSG_E2E_DATA_ROOT = priorRunRoot;
    rmSync(workflowDirectory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});
