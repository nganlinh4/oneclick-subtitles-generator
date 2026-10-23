// Customer screenshots, failure promotion and copied artifacts for the active attempt.

import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import process from 'node:process';

import { assertOrdinaryPath, copyRetryingOnScan } from './files.js';
import { activeAttempt, readActiveManifest } from './lifecycle.js';
import {
  allocateAttemptOperationPayload, createAttemptOperation, discardUncommittedAttemptOperation,
  sealAttemptOperationPayload, stageAttemptOperationContents, writeManifest,
} from './operation.js';
import { ATTEMPT_ENVIRONMENT_KEY, safeSegment } from './paths.js';
import {
  appLogTails, bestEffortVisibleState, boundedBrowserDiagnostics, validateVisibleState,
  visibleState,
} from './visibleState.js';

/* global browser, document, window */

const MIN_SCREENSHOT_BYTES = 1_000;
const captureFailureDiagnostics = async ({ manifest, operation, state }) => {
  const browserFile = 'diagnostics/browser-state.json';
  const appLogFile = 'diagnostics/app-log-tails.json';
  stageAttemptOperationContents(
    operation,
    browserFile,
    `${JSON.stringify(await boundedBrowserDiagnostics(state), null, 2)}\n`,
  );
  stageAttemptOperationContents(
    operation,
    appLogFile,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), files: appLogTails() }, null, 2)}\n`,
  );
  const retained = manifest.diagnostics.filter(({ name }) => (
    name !== 'browser-state' && name !== 'app-log-tails'
  ));
  manifest.diagnostics = [
    ...retained,
    {
      name: 'browser-state',
      file: browserFile,
      description: 'Bounded WebView URL, viewport, visible state and browser log tail.',
    },
    {
      name: 'app-log-tails',
      file: appLogFile,
      description: 'At most eight app log tails, capped at 16 KiB each, copied before root cleanup.',
    },
  ].sort((left, right) => left.name.localeCompare(right.name));
};

// JavaScript exposes locale case conversion, not Unicode's full case-fold operation. Uppercasing
// before lowercasing preserves the important expansion folds (`ß` -> `SS` -> `ss`) and also
// collapses context-sensitive variants such as final sigma. NFC is applied again because case
// conversion can introduce combining sequences. This is stricter than a plain lowercase key and
// matches the fail-closed identity we need for evidence names on case-insensitive filesystems.
const evidenceCollisionKey = value => value
  .normalize('NFC')
  .toLocaleUpperCase('en-US')
  .toLocaleLowerCase('en-US')
  .normalize('NFC');

const assertScreenshotArtifactSeparation = ({ manifest, screenshot, step }) => {
  const screenshotKey = evidenceCollisionKey(screenshot);
  const stepKey = evidenceCollisionKey(step);
  const collision = manifest.artifacts.find((artifact) => (
    evidenceCollisionKey(artifact.name) === stepKey
    || evidenceCollisionKey(artifact.file) === screenshotKey
  ));
  assert.equal(collision, undefined, (
    `workflow screenshot ${screenshot} collides with independent artifact `
    + `${collision?.name ?? 'unknown'}; customer screenshots and artifacts need distinct names`
  ));
};

const assertScreenshotScreenshotSeparation = ({ manifest, screenshot, step }) => {
  const screenshotKey = evidenceCollisionKey(screenshot);
  const stepKey = evidenceCollisionKey(step);
  const collision = manifest.steps.find((candidate) => (
    evidenceCollisionKey(candidate.step) === stepKey
    || evidenceCollisionKey(candidate.screenshot) === screenshotKey
  ));
  assert.equal(collision, undefined, (
    `workflow screenshot ${screenshot} collides with existing customer screenshot `
    + `${collision?.screenshot ?? 'unknown'}; evidence checkpoints are immutable within one attempt`
  ));
};

const assertArtifactScreenshotSeparation = ({ file, manifest, name }) => {
  const fileKey = evidenceCollisionKey(file);
  const nameKey = evidenceCollisionKey(name);
  const collision = manifest.steps.find((step) => (
    evidenceCollisionKey(step.step) === nameKey
    || evidenceCollisionKey(step.screenshot) === fileKey
  ));
  assert.equal(collision, undefined, (
    `workflow artifact ${file} collides with customer screenshot `
    + `${collision?.screenshot ?? 'unknown'}; artifacts and screenshots need distinct names`
  ));
};

const assertArtifactArtifactSeparation = ({ file, manifest, name }) => {
  const fileKey = evidenceCollisionKey(file);
  const nameKey = evidenceCollisionKey(name);
  const collision = manifest.artifacts.find((artifact) => (
    evidenceCollisionKey(artifact.name) === nameKey
    || evidenceCollisionKey(artifact.file) === fileKey
  ));
  assert.equal(collision, undefined, (
    `workflow artifact ${file} collides with existing independent artifact `
    + `${collision?.file ?? 'unknown'}; artifacts in one attempt need distinct names and files`
  ));
};

/**
 * Emergency evidence path used by WebdriverIO's failure hook.
 *
 * A journey can fail before its first deliberate checkpoint, and the operation that failed can
 * also leave WebView script evaluation unavailable. The ordinary checkpoint path evaluates the
 * page before taking a screenshot, so it cannot be the only failure recorder. The hook first saves
 * a raw screenshot in the isolated run root and this function atomically imports it into the
 * immutable attempt. Browser state and logs remain best-effort; failure to evaluate the page must
 * never discard a screenshot that WebDriver already returned.
 */
export const promoteWorkflowFailureEvidence = async ({
  workflow,
  step,
  description,
  fallbackScreenshot = null,
}) => {
  safeSegment(step, 'step');
  assert.ok(step.startsWith('failure-'), 'emergency evidence step must describe a failure');
  assert.equal(typeof description, 'string');
  assert.ok(description.trim().length > 0, 'failure evidence needs a human-readable purpose');
  const { directory } = activeAttempt(workflow);
  assertOrdinaryPath(directory, 'directory', 'active workflow evidence attempt');
  const screenshot = `${step}.png`;
  const path = join(directory, screenshot);
  const manifest = readActiveManifest(workflow);
  assertScreenshotArtifactSeparation({ manifest, screenshot, step });
  assertScreenshotScreenshotSeparation({ manifest, screenshot, step });
  assert.equal(existsSync(path), false, `workflow screenshot path already exists outside its manifest: ${screenshot}`);
  const operation = createAttemptOperation({
    workflow, attemptId: manifest.attempt.id, directory,
  });
  let screenshotUnavailable = null;
  let fallbackScreenshotImported = false;
  let screenshotStaged = false;

  try {
    if (fallbackScreenshot !== null) {
      assert.equal(typeof fallbackScreenshot, 'string');
      try {
        const bytes = readFileSync(fallbackScreenshot);
        assert.ok(
          bytes.byteLength > MIN_SCREENSHOT_BYTES,
          `fallback workflow screenshot is implausibly small: ${fallbackScreenshot}`,
        );
        stageAttemptOperationContents(operation, screenshot, bytes);
        fallbackScreenshotImported = true;
        screenshotStaged = true;
      } catch (error) {
        screenshotUnavailable = String(error?.message ?? error).slice(0, 500);
      }
    }
    if (!screenshotStaged) {
      try {
        // Same constraint as captureWorkflowStep: the staged name is journal-owned and not `.png`,
        // so take the PNG bytes directly rather than letting WebdriverIO validate the extension.
        const screenshotBytes = Buffer.from(await browser.takeScreenshot(), 'base64');
        assert.ok(
          screenshotBytes.byteLength > MIN_SCREENSHOT_BYTES,
          `workflow screenshot is implausibly small: ${screenshot}`,
        );
        stageAttemptOperationContents(operation, screenshot, screenshotBytes);
        screenshotStaged = true;
        screenshotUnavailable = null;
      } catch (error) {
        screenshotUnavailable = String(error?.message ?? error).slice(0, 500);
      }
    }

    const state = await bestEffortVisibleState();
    if (screenshotUnavailable !== null) state.screenshotUnavailable = screenshotUnavailable;
    if (screenshotStaged) {
      const record = {
        step,
        description: description.trim(),
        screenshot,
        state,
        details: {
          emergencyCapture: true,
          fallbackScreenshotImported,
        },
        allowance: {},
      };
      manifest.steps.push(record);
      manifest.steps.sort((left, right) => left.step.localeCompare(right.step));
    }
    await captureFailureDiagnostics({ manifest, operation, state });
    writeManifest(manifest, { operation });
    return {
      directory,
      screenshot: screenshotStaged ? path : null,
      state,
    };
  } finally {
    discardUncommittedAttemptOperation(operation);
  }
};

export const captureWorkflowStep = async ({
  workflow,
  step,
  description,
  details = {},
  focusSelector = null,
  allowVisibleProblems = {},
}) => {
  safeSegment(step, 'step');
  assert.equal(typeof description, 'string');
  assert.ok(description.trim().length > 0, 'evidence needs a human-readable purpose');
  const { directory } = activeAttempt(workflow);
  assertOrdinaryPath(directory, 'directory', 'active workflow evidence attempt');
  const screenshot = `${step}.png`;
  const path = join(directory, screenshot);
  const manifest = readActiveManifest(workflow);
  assertScreenshotArtifactSeparation({ manifest, screenshot, step });
  assertScreenshotScreenshotSeparation({ manifest, screenshot, step });
  assert.equal(existsSync(path), false, `workflow screenshot path already exists outside its manifest: ${screenshot}`);
  const operation = createAttemptOperation({
    workflow, attemptId: manifest.attempt.id, directory,
  });
  try {
    if (focusSelector !== null) {
      assert.equal(typeof focusSelector, 'string');
      assert.ok(focusSelector.length > 0 && focusSelector.length <= 200, 'focus selector must be bounded');
      const focus = await browser.execute((selector) => {
        const node = document.querySelector(selector);
        if (node === null) return { found: false, insideSettingsModal: false, inViewport: false };
        const rect = node.getBoundingClientRect();
        const inViewport = rect.top >= 0 && rect.left >= 0
          && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
        // Settings owns its own bounded scroller. Calling scrollIntoView on a descendant may scroll
        // the fixed modal or the document itself, mutating the surface that the evidence is meant to
        // observe. Journeys must place Settings controls themselves; capture is read-only there.
        const insideSettingsModal = node.closest('.settings-modal') !== null;
        if (!insideSettingsModal && !inViewport) {
          node.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
        }
        return { found: true, insideSettingsModal, inViewport };
      }, focusSelector);
      assert.ok(focus?.found, `workflow evidence focus target is missing: ${focusSelector}`);
      assert.ok(!(focus.insideSettingsModal && !focus.inViewport), (
        `workflow evidence focus target is outside the visible Settings viewport: ${focusSelector}`
      ));
      await browser.pause(100);
    }
    // WebDriver can leave a document selection painted after Ctrl+A even after the control handled it.
    await browser.execute(() => window.getSelection()?.removeAllRanges());
    // Capture the settled surface rather than an intermediate opacity frame.
    await browser.pause(300);
    const state = await visibleState();
    // WebdriverIO's saveScreenshot validates the file extension, but the payload is staged under a
    // journal-owned `.tmp` name until its atomic rename. Take the PNG bytes directly instead.
    const screenshotBytes = Buffer.from(await browser.takeScreenshot(), 'base64');
    assert.ok(
      screenshotBytes.byteLength > MIN_SCREENSHOT_BYTES,
      `workflow screenshot is implausibly small: ${screenshot}`,
    );
    stageAttemptOperationContents(operation, screenshot, screenshotBytes);

    const record = {
      step,
      description: description.trim(),
      screenshot,
      state,
      details,
      allowance: allowVisibleProblems,
    };
    manifest.steps.push(record);
    manifest.steps.sort((left, right) => left.step.localeCompare(right.step));
    if (step.startsWith('failure-')) {
      await captureFailureDiagnostics({ manifest, operation, state });
    }
    writeManifest(manifest, { operation });
    validateVisibleState(state, allowVisibleProblems);
    return record;
  } finally {
    discardUncommittedAttemptOperation(operation);
  }
};

/** One bounded artifact slug for a file preserved from a failed run root. */
export const runRootArtifactName = (relativePath) => {
  const stem = relativePath.replace(/\.[^./\\]+$/u, '');
  const slug = `run-root-${stem}`.toLowerCase().replace(/[^a-z0-9]+/gu, '-')
    .slice(0, 80).replace(/^-+|-+$/gu, '');
  safeSegment(slug, 'preserved run-root artifact name');
  return slug;
};

/**
 * Promote a failed run root's staged evidence into the durable attempt THROUGH the publisher.
 *
 * The attempt tree is publisher-owned: every file must be journaled and manifest-recorded, so a
 * raw directory copy is (correctly) refused at finalization. Each preserved file therefore goes
 * through the same artifact operation a journey uses, with a bounded count and byte budget so a
 * pathological run cannot flood the evidence lane.
 */
export const preserveRunRootEvidence = ({
  workflow,
  runRoot,
  attemptId = null,
  maximumFiles = 200,
  maximumBytes = 512 * 1024 * 1024,
}) => {
  const sourceRoot = join(runRoot, 'evidence');
  if (!existsSync(sourceRoot)) return Object.freeze({ preserved: 0, skipped: 0 });
  // The artifact copier resolves its attempt from the environment; the isolated runner sets that
  // variable only on its CHILD, so without pinning it here the preserved files would land in a
  // freshly minted implicit attempt beside the one that actually failed.
  const priorAttempt = process.env[ATTEMPT_ENVIRONMENT_KEY];
  if (attemptId !== null) process.env[ATTEMPT_ENVIRONMENT_KEY] = attemptId;
  try {
    return preserveInto({ workflow, sourceRoot, maximumFiles, maximumBytes });
  } finally {
    if (attemptId !== null) {
      if (priorAttempt === undefined) delete process.env[ATTEMPT_ENVIRONMENT_KEY];
      else process.env[ATTEMPT_ENVIRONMENT_KEY] = priorAttempt;
    }
  }
};

const preserveInto = ({ workflow, sourceRoot, maximumFiles, maximumBytes }) => {
  const files = [];
  const pending = [sourceRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        files.push({ path, relativePath: relative(sourceRoot, path).split(sep).join('/') });
      }
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  let preserved = 0;
  let skipped = 0;
  let bytes = 0;
  for (const file of files) {
    const size = statSync(file.path).size;
    if (preserved >= maximumFiles || bytes + size > maximumBytes) {
      skipped += 1;
      continue;
    }
    try {
      copyWorkflowArtifact({
        workflow,
        name: runRootArtifactName(file.relativePath),
        source: file.path,
        description: `Preserved from the failed run root: ${file.relativePath}`,
      });
      preserved += 1;
      bytes += size;
    } catch {
      // A name collision or refused file must not abort preservation of the remaining evidence.
      skipped += 1;
    }
  }
  return Object.freeze({ preserved, skipped });
};

export const copyWorkflowArtifact = ({ workflow, name, source, description }) => {
  safeSegment(name, 'artifact name');
  assert.ok(existsSync(source), `workflow artifact does not exist: ${source}`);
  const { directory } = activeAttempt(workflow);
  assertOrdinaryPath(directory, 'directory', 'active workflow evidence attempt');
  const base = basename(source);
  const extension = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
  const file = `${name}${extension}`;
  const manifest = readActiveManifest(workflow);
  assertArtifactScreenshotSeparation({ file, manifest, name });
  assertArtifactArtifactSeparation({ file, manifest, name });
  const destination = join(directory, file);
  assert.equal(existsSync(destination), false, `workflow artifact path already exists outside its manifest: ${file}`);
  const operation = createAttemptOperation({
    workflow, attemptId: manifest.attempt.id, directory,
  });
  try {
    const stagedArtifact = allocateAttemptOperationPayload(operation, file);
    copyRetryingOnScan(source, stagedArtifact);
    sealAttemptOperationPayload(operation, stagedArtifact);
    manifest.artifacts.push({ name, file, description });
    manifest.artifacts.sort((left, right) => left.name.localeCompare(right.name));
    writeManifest(manifest, { operation });
    return destination;
  } finally {
    discardUncommittedAttemptOperation(operation);
  }
};
