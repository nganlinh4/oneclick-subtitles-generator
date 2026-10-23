import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  beginWorkflowEvidence, boundedWorkflowTestFailure, finalizeWorkflowEvidence,
  recordWorkflowTestFailure, refreshWorkflowEvidenceIndex, resetWorkflowEvidence,
  runRootArtifactName, workflowEvidenceDirectory, workflowFailureStepForTest,
  workflowNameForJourney, cleanupWorkflowEvidenceTestRoot, derivativeFixture, workflowForTest,
  workflowEvidenceModuleUrl, fixedProvenance,
} from './workflowEvidenceTestHarness.js';

test.after(cleanupWorkflowEvidenceTestRoot);
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

test('refuses new evidence whose injected source provenance omits the Git tree', () => {
  const workflow = workflowForTest('missing-source-tree');
  const provenance = fixedProvenance();
  delete provenance.source.tree;
  try {
    assert.throws(() => beginWorkflowEvidence({
      workflow,
      journey: 'journeys/missing-tree.journey.js',
      iteration: 1,
      provenance,
      requireBinary: false,
    }), /exact source tree/u);
  } finally {
    rmSync(workflowEvidenceDirectory(workflow), { recursive: true, force: true });
  }
});

test('pure evidence module bootstraps without a current application receipt', () => {
  for (const historicalReceipt of [false, true]) {
    const cache = mkdtempSync(join(tmpdir(), 'osg-evidence-bootstrap-cache-'));
    try {
      if (historicalReceipt) {
        const receipts = join(cache, 'apps', 'e2e', 'receipts');
        mkdirSync(receipts, { recursive: true });
        writeFileSync(join(receipts, 'current.json'), JSON.stringify({
          schemaVersion: 2,
          applicationHash: 'a'.repeat(64),
          // Deliberately historical/provenance-less and otherwise unverifiable. Pure evidence
          // import must not consult launch publication; actual launch authority still does.
        }));
      }
      const environment = { ...process.env };
      delete environment.OSG_E2E_WORKFLOW_EVIDENCE_ROOT;
      environment.OSG_DEV_CACHE_ROOT = cache;
      const child = spawnSync(process.execPath, [
        '--input-type=module',
        '--eval',
        `await import(${JSON.stringify(workflowEvidenceModuleUrl)}); process.stdout.write('ok');`,
      ], {
        cwd: resolve(import.meta.dirname, '..', '..'),
        encoding: 'utf8',
        env: environment,
        windowsHide: true,
      });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, 'ok');
      const launchEvidence = spawnSync(process.execPath, [
        '--input-type=module',
        '--eval',
        `const evidence = await import(${JSON.stringify(workflowEvidenceModuleUrl)}); `
          + "evidence.beginWorkflowEvidence({ workflow: 'bootstrap-launch', "
          + "journey: 'journeys/bootstrap.journey.js', iteration: 1 });",
      ], {
        cwd: resolve(import.meta.dirname, '..', '..'),
        encoding: 'utf8',
        env: environment,
        windowsHide: true,
      });
      assert.notEqual(launchEvidence.status, 0, 'an actual journey must still require publication');
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }
});

test('scenario reset and staged derivative retain exact source application identity', () => {
  const workflow = workflowForTest('scenario-application');
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-scenario-application-'));
  const binary = join(scratch, 'osg-e2e.exe');
  const applicationHash = 'd'.repeat(64);
  writeFileSync(binary, 'scenario-application-binary');
  try {
    const resetDirectory = resetWorkflowEvidence(workflow, { applicationHash, binaryPath: binary });
    const resetManifest = JSON.parse(readFileSync(join(resetDirectory, 'manifest.json'), 'utf8'));
    assert.equal(resetManifest.provenance.applicationHash, applicationHash);
    assert.equal(resetManifest.provenance.applicationDerivative, null);

    const derivative = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/damagedFontPayload.journey.js',
      iteration: 2,
      applicationHash,
      applicationDerivative: derivativeFixture(applicationHash),
      binaryPath: binary,
    });
    finalizeWorkflowEvidence({
      workflow,
      attemptId: derivative.id,
      outcome: 'pass',
      exitStatus: 0,
    });
    const pointer = JSON.parse(readFileSync(
      join(workflowEvidenceDirectory(workflow), 'latest-success.json'),
      'utf8',
    ));
    assert.equal(pointer.applicationHash, applicationHash);
    assert.deepEqual(pointer.applicationDerivative, derivativeFixture(applicationHash));
  } finally {
    delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    rmSync(workflowEvidenceDirectory(workflow), { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
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

test('a scenario wrapper summary never erases the recorded assertion', () => {
  const workflow = workflowForTest('scenario-summary');
  const root = workflowEvidenceDirectory(workflow);
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-scenario-summary-'));
  const binary = join(scratch, 'osg-e2e.exe');
  const priorAttempt = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  writeFileSync(binary, 'guarded');
  try {
    const attempt = beginWorkflowEvidence({
      workflow,
      journey: 'legacy-multi-process-scenario',
      iteration: 1,
      binaryPath: binary,
    });
    process.env.OSG_E2E_EVIDENCE_ATTEMPT = attempt.id;
    recordWorkflowTestFailure({
      workflow,
      test: { title: 'starts a cancellable install', parent: 'narration model package' },
      error: {
        name: 'Error',
        message: 'clicking Install never produced a cancellable operation',
      },
      capturedAt: '2026-08-26T00:01:00.000Z',
    });
    const finalized = finalizeWorkflowEvidence({
      workflow,
      attemptId: attempt.id,
      outcome: 'fail',
      exitStatus: 1,
      failure: 'the narration model management process failed',
      endedAt: '2026-08-26T00:02:00.000Z',
    });
    assert.match(finalized.attempt.failure, /clicking Install never produced a cancellable operation/u);
    assert.match(finalized.attempt.failure,
      /\[scenario: the narration model management process failed\]/u,
      'the wrapper summary must be kept alongside, not instead of, the recorded assertion');
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

test('preserved run-root files get bounded publisher slugs', () => {
  assert.equal(
    runRootArtifactName('export-animation-parity-matrix/03-slide-down-arabic-glow/exit-decoded-export.png'),
    'run-root-export-animation-parity-matrix-03-slide-down-arabic-glow-exit-decoded-e',
  );
  assert.equal(runRootArtifactName('a.png'), 'run-root-a');
  assert.equal(runRootArtifactName('Case X/File.Name.PNG'), 'run-root-case-x-file-name');
  assert.ok(runRootArtifactName(`${'x'.repeat(200)}.png`).length <= 80);
});
