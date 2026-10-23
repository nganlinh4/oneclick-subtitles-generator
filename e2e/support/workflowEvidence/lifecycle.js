// Attempt lifecycle: begin, finalize, scenario reset, the active attempt, and durable
// failure/diagnostic records.

import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';

import {
  ATTEMPT_PUBLICATION_JOURNAL, readAttemptManifest, recoverAttemptPublicationTemporaries,
  validateAttemptPublicationJournal,
} from './attempts.js';
import { boundedFailureText, boundedWorkflowTestFailure } from './failure.js';
import { atomicWriteFile, readJson, testCrashPoint } from './files.js';
import {
  attemptReadmeContents, initialManifest, newAttemptId, serializedManifest,
} from './manifest.js';
import {
  createAttemptOperation, discardUncommittedAttemptOperation, stageAttemptOperationContents,
  writeManifest,
} from './operation.js';
import {
  ATTEMPT_ENVIRONMENT_KEY, attemptDirectory, EVIDENCE_PUBLISHER, readDefaultPublishedApplication,
  safeSegment, workflowEvidenceDirectory,
} from './paths.js';
import { collectEvidenceProvenance, normalizeApplicationDerivative } from './provenance.js';
import { refreshRootReadme, refreshWorkflowReadme } from './readme.js';
import { applyWorkflowEvidenceRetention } from './retention.js';

const MAX_TEST_FAILURES = 8;
const MAX_ATTEMPT_FAILURE = 2_000;
export const beginWorkflowEvidence = ({
  workflow,
  journey,
  iteration,
  applicationDerivative = null,
  applicationHash = null,
  binaryPath = null,
  provenance = null,
  startedAt = new Date().toISOString(),
  requireBinary = true,
}) => {
  safeSegment(workflow, 'workflow');
  assert.equal(typeof journey, 'string');
  assert.ok(journey.length > 0 && journey.length <= 260, 'journey must be a bounded path');
  assert.ok(Number.isSafeInteger(iteration) && iteration >= 1, 'iteration must be positive');
  assert.doesNotThrow(() => new Date(startedAt).toISOString(), 'startedAt must be ISO-compatible');
  const attemptsRoot = join(workflowEvidenceDirectory(workflow), 'attempts');
  mkdirSync(attemptsRoot, { recursive: true });
  recoverAttemptPublicationTemporaries(workflow);
  applyWorkflowEvidenceRetention(workflow);
  const attemptId = newAttemptId();
  const directory = attemptDirectory(workflow, attemptId);
  const temporary = join(
    attemptsRoot,
    `.osg-attempt-${attemptId}-${randomBytes(12).toString('hex')}.tmp`,
  );
  let selectedBinaryPath = binaryPath;
  let selectedApplicationHash = applicationHash;
  if (provenance === null && selectedBinaryPath === null) {
    if (!requireBinary && process.env.NODE_TEST_CONTEXT !== undefined) {
      selectedBinaryPath = join(tmpdir(), 'osg-evidence-no-application', 'osg-desktop.exe');
    } else {
      const publication = readDefaultPublishedApplication();
      selectedBinaryPath = publication.binaryPath;
      selectedApplicationHash = publication.applicationHash;
    }
  }
  const attemptProvenance = provenance ?? collectEvidenceProvenance({
    applicationDerivative,
    applicationHash: selectedApplicationHash,
    binaryPath: selectedBinaryPath,
    requireBinary,
  });
  assert.ok(
    attemptProvenance?.applicationHash === undefined
      || attemptProvenance.applicationHash === null
      || /^[0-9a-f]{64}$/u.test(attemptProvenance.applicationHash),
    'workflow evidence application hash must be an exact SHA-256 or null',
  );
  normalizeApplicationDerivative(attemptProvenance?.applicationDerivative);
  assert.match(
    attemptProvenance?.source?.commit ?? '',
    /^[0-9a-f]{40,64}$/i,
    'workflow evidence requires an exact source commit',
  );
  assert.match(
    attemptProvenance?.source?.tree ?? '',
    /^[0-9a-f]{40,64}$/i,
    'workflow evidence requires an exact source tree',
  );
  assert.equal(
    typeof attemptProvenance?.source?.dirty,
    'boolean',
    'workflow evidence requires an explicit source dirty state',
  );
  const manifest = initialManifest({
    attemptId,
    iteration,
    journey,
    provenance: attemptProvenance,
    startedAt,
    workflow,
  });
  const publicationJournalPath = join(attemptsRoot, ATTEMPT_PUBLICATION_JOURNAL);
  const publicationJournal = {
    schemaVersion: 1,
    publisher: EVIDENCE_PUBLISHER,
    workflow,
    attemptId,
    temporary: basename(temporary),
  };
  validateAttemptPublicationJournal({ journal: publicationJournal, workflow });
  atomicWriteFile(publicationJournalPath, `${JSON.stringify(publicationJournal, null, 2)}\n`);
  let published = false;
  try {
    testCrashPoint('begin-after-journal');
    mkdirSync(temporary);
    testCrashPoint('begin-after-directory');
    atomicWriteFile(join(temporary, 'manifest.json'), serializedManifest(manifest));
    testCrashPoint('begin-after-manifest');
    atomicWriteFile(join(temporary, 'README.md'), attemptReadmeContents(manifest));
    testCrashPoint('begin-before-publish');
    renameSync(temporary, directory);
    published = true;
    testCrashPoint('begin-after-publish');
    rmSync(publicationJournalPath);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    if (existsSync(publicationJournalPath) && (published || !existsSync(directory))) {
      rmSync(publicationJournalPath);
    }
  }
  refreshWorkflowReadme(workflow);
  refreshRootReadme();
  return { id: attemptId, directory, manifest };
};

export const finalizeWorkflowEvidence = ({
  workflow,
  attemptId,
  outcome,
  exitStatus = null,
  signal = null,
  failure = null,
  endedAt = new Date().toISOString(),
}) => {
  assert.ok(outcome === 'pass' || outcome === 'fail', 'attempt outcome must be pass or fail');
  const manifest = readAttemptManifest(workflow, attemptId);
  assert.equal(manifest.attempt.outcome, 'running', 'workflow evidence attempt was already finalized');
  // Captured before the fields below are overwritten: a non-null failure here can only come from
  // recordWorkflowTestFailure, which already names the exact assertion that failed.
  const recordedTestFailure = manifest.attempt.failure;
  manifest.attempt.endedAt = endedAt;
  manifest.attempt.outcome = outcome;
  manifest.attempt.exitStatus = exitStatus;
  manifest.attempt.signal = signal;
  const keepsRecordedFailure = outcome === 'fail' && recordedTestFailure !== null;
  if (failure !== null) {
    // Multi-process scenarios wrap the runner and finalize with their own summary ("the narration
    // model management process failed"). That names the process, never the assertion, so it must
    // not replace a recorded test failure -- a failure that does not name itself costs a whole
    // diagnosis cycle. Keep the precise text and append the wrapper's only when it adds something.
    const scenarioFailure = boundedFailureText(failure, MAX_ATTEMPT_FAILURE).value;
    if (!keepsRecordedFailure) {
      manifest.attempt.failure = scenarioFailure;
    } else if (!recordedTestFailure.includes(scenarioFailure)) {
      manifest.attempt.failure = boundedFailureText(
        `${recordedTestFailure} [scenario: ${scenarioFailure}]`,
        MAX_ATTEMPT_FAILURE,
      ).value;
    }
  } else if (outcome === 'pass') {
    manifest.attempt.failure = null;
  } else if (recordedTestFailure === null) {
    const terminal = signal === null
      ? `exit status ${exitStatus ?? 'unknown'}`
      : `signal ${signal}`;
    manifest.attempt.failure = (
      `WebdriverIO failed with ${terminal} before its test hook captured an Error; `
      + 'inspect the bounded browser and application diagnostics.'
    ).slice(0, MAX_ATTEMPT_FAILURE);
  }
  writeManifest(manifest);
  if (outcome === 'pass') {
    const pointer = {
      schemaVersion: 1,
      workflow,
      attemptId,
      path: `attempts/${attemptId}`,
      endedAt,
      commit: manifest.provenance.source.commit,
      tree: manifest.provenance.source.tree,
      dirty: manifest.provenance.source.dirty,
      binarySha256: manifest.provenance.binary.sha256,
      ...(manifest.provenance.applicationHash === null
        || manifest.provenance.applicationHash === undefined
        ? {}
        : { applicationHash: manifest.provenance.applicationHash }),
      ...(manifest.provenance.applicationDerivative === null
        || manifest.provenance.applicationDerivative === undefined
        ? {}
        : { applicationDerivative: manifest.provenance.applicationDerivative }),
    };
    atomicWriteFile(
      join(workflowEvidenceDirectory(workflow), 'latest-success.json'),
      `${JSON.stringify(pointer, null, 2)}\n`,
    );
  }
  applyWorkflowEvidenceRetention(workflow);
  refreshWorkflowReadme(workflow);
  refreshRootReadme();
  return manifest;
};

/**
 * Backward-compatible scenario entry point. "Reset" starts a new immutable attempt. Finalization
 * applies the same bounded latest-success-plus-recent retention as the single-process runner.
 */
export const resetWorkflowEvidence = (workflow, {
  applicationHash = null,
  binaryPath = null,
} = {}) => {
  if ((applicationHash === null) !== (binaryPath === null)) {
    throw new Error('scenario evidence application hash and binary must be supplied together');
  }
  const attempt = beginWorkflowEvidence({
    workflow,
    journey: 'legacy-multi-process-scenario',
    iteration: 1,
    applicationHash,
    binaryPath,
    requireBinary: applicationHash !== null,
  });
  process.env[ATTEMPT_ENVIRONMENT_KEY] = attempt.id;
  return attempt.directory;
};

export const activeAttempt = (workflow) => {
  let attemptId = process.env[ATTEMPT_ENVIRONMENT_KEY];
  if (attemptId === undefined) {
    const implicit = beginWorkflowEvidence({
      workflow,
      journey: 'direct-wdio-invocation',
      iteration: 1,
      requireBinary: false,
    });
    attemptId = implicit.id;
    process.env[ATTEMPT_ENVIRONMENT_KEY] = attemptId;
  }
  safeSegment(attemptId, 'attempt');
  return { attemptId, directory: attemptDirectory(workflow, attemptId) };
};

export const readActiveManifest = (workflow) => {
  const { attemptId } = activeAttempt(workflow);
  return readAttemptManifest(workflow, attemptId);
};

/**
 * Persist the Mocha/WebdriverIO failure before attempting any WebView diagnostics. A renderer or
 * transport failure can make screenshots and page evaluation unavailable, but the hook's Error
 * object is already local and must not be lost with the worker process.
 */
export const recordWorkflowTestFailure = ({ workflow, test, error, capturedAt }) => {
  const { directory } = activeAttempt(workflow);
  const manifest = readActiveManifest(workflow);
  assert.equal(manifest.attempt.outcome, 'running', 'test failure belongs to a finalized attempt');
  const operation = createAttemptOperation({
    workflow, attemptId: manifest.attempt.id, directory,
  });
  const record = boundedWorkflowTestFailure({ test, error, capturedAt });
  const file = 'diagnostics/test-failures.json';
  const path = join(directory, file);
  const existing = readJson(path, {
    schemaVersion: 1,
    failures: [],
    droppedEarlierFailures: 0,
  });
  assert.equal(existing?.schemaVersion, 1, 'test-failure evidence has an unknown schema');
  const failures = Array.isArray(existing.failures) ? [...existing.failures, record] : [record];
  const dropped = Math.max(0, failures.length - MAX_TEST_FAILURES);
  const document = {
    schemaVersion: 1,
    failures: failures.slice(-MAX_TEST_FAILURES),
    droppedEarlierFailures: Number(existing.droppedEarlierFailures ?? 0) + dropped,
  };
  stageAttemptOperationContents(operation, file, `${JSON.stringify(document, null, 2)}\n`);

  const summary = `${record.test.parent ? `${record.test.parent} — ` : ''}${record.test.title}: `
    + `${record.error.name}: ${record.error.message}`;
  manifest.attempt.failure = summary.slice(0, MAX_ATTEMPT_FAILURE);
  manifest.diagnostics = manifest.diagnostics.filter(({ name }) => name !== 'test-failures');
  manifest.diagnostics.push({
    name: 'test-failures',
    file,
    description: 'Up to eight exact failed test identities, messages and stacks; credentials redacted and fields capped.',
  });
  manifest.diagnostics.sort((left, right) => left.name.localeCompare(right.name));
  try {
    writeManifest(manifest, { operation });
    return record;
  } finally {
    discardUncommittedAttemptOperation(operation);
  }
};

/**
 * Persist one arbitrary, already-bounded JSON diagnostic that a journey staged for itself — the
 * same stage/register/commit mechanism as `recordWorkflowTestFailure` above and the failure-hook
 * diagnostics further down, generalized so a journey can call it directly instead of growing its
 * own copy of the operation/manifest plumbing. Used when a journey holds witness or ledger data in
 * memory that would otherwise die with the process the instant a domain assertion throws; the
 * caller owns bounding and redacting `document` before calling this.
 */
export const recordWorkflowDiagnostic = ({
  workflow, name, file, description, document,
}) => {
  safeSegment(name, 'diagnostic name');
  const { directory } = activeAttempt(workflow);
  const manifest = readActiveManifest(workflow);
  assert.equal(manifest.attempt.outcome, 'running', 'diagnostic belongs to a finalized attempt');
  const operation = createAttemptOperation({
    workflow, attemptId: manifest.attempt.id, directory,
  });
  stageAttemptOperationContents(operation, file, `${JSON.stringify(document, null, 2)}\n`);
  manifest.diagnostics = manifest.diagnostics.filter((entry) => entry.name !== name);
  manifest.diagnostics.push({ name, file, description });
  manifest.diagnostics.sort((left, right) => left.name.localeCompare(right.name));
  try {
    writeManifest(manifest, { operation });
  } finally {
    discardUncommittedAttemptOperation(operation);
  }
};
