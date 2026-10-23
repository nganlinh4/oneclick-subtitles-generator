// Screenshots, independent artifacts and failure-capture evidence for the active attempt.

import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  beginWorkflowEvidence, captureWorkflowStep, copyWorkflowArtifact,
  promoteWorkflowFailureEvidence, recordWorkflowTestFailure, refreshWorkflowEvidenceIndex,
  workflowEvidenceDirectory, cleanupWorkflowEvidenceTestRoot, workflowForTest,
} from './workflowEvidenceTestHarness.js';

test.after(cleanupWorkflowEvidenceTestRoot);
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
