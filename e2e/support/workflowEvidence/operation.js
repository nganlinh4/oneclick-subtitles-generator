// Journaled attempt operations: staged payloads that commit atomically with the manifest,
// and recovery of an operation interrupted by a hard kill.

import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  applyAtomicSidecarRepairs, assertFileIdentity, assertOrdinaryPath, atomicSidecarsForTarget,
  atomicWriteFile, fileIdentity, inspectOwnedAttemptTree, openRetryingOnScan, readJson, samePath,
  sha256, testCrashPoint,
} from './files.js';
import {
  assertOwnedAttemptManifest, attemptReadmeContents, manifestHasOwnedIdentity, ownedAttemptFiles,
  recoverAttemptManifestSidecar, safeManifestRelativePath, serializedManifest,
} from './manifest.js';
import { attemptDirectory, EVIDENCE_PUBLISHER, insideDirectory } from './paths.js';

const ATTEMPT_OPERATION_JOURNAL = '.osg-evidence-operation.json';
const ATTEMPT_OPERATION_PAYLOAD_PATTERN = /^\.osg-evidence-payload-([0-9a-f]{32})-(\d{1,3})\.tmp$/u;
const attemptOperationJournalPath = directory => join(directory, ATTEMPT_OPERATION_JOURNAL);

const attemptOperationPayloadFiles = (directory) => readdirSync(directory, { withFileTypes: true })
  .filter(entry => entry.name.startsWith('.osg-evidence-payload-'))
  .map((entry) => {
    const match = ATTEMPT_OPERATION_PAYLOAD_PATTERN.exec(entry.name);
    assert.ok(
      match && entry.isFile() && !entry.isSymbolicLink(),
      `publisher-owned evidence contains an unknown operation payload: ${entry.name}`,
    );
    const path = join(directory, entry.name);
    assertOrdinaryPath(path, 'file', 'evidence operation payload');
    return { name: entry.name, operationId: match[1], path };
  });

const validateAttemptOperationJournal = ({ journal, workflow, attemptId, directory }) => {
  assert.equal(journal?.schemaVersion, 1, 'evidence operation journal has an unknown schema');
  assert.equal(journal?.publisher, EVIDENCE_PUBLISHER,
    'evidence operation journal has an unknown publisher');
  assert.equal(journal?.workflow, workflow, 'evidence operation journal changed workflow');
  assert.equal(journal?.attemptId, attemptId, 'evidence operation journal changed attempt');
  assert.match(journal?.operationId ?? '', /^[0-9a-f]{32}$/u,
    'evidence operation journal has an invalid operation ID');
  assert.match(journal?.beforeManifestSha256 ?? '', /^[0-9a-f]{64}$/u,
    'evidence operation journal has an invalid prior-manifest digest');
  assert.ok(journal?.phase === 'staging' || journal?.phase === 'committed',
    'evidence operation journal has an unknown phase');
  if (journal.phase === 'staging') {
    assert.equal(journal.afterManifest, null,
      'staging evidence operation journal published a replacement manifest');
  } else {
    assert.ok(manifestHasOwnedIdentity(journal?.afterManifest, workflow, attemptId),
      'evidence operation journal has a foreign replacement manifest');
  }
  const afterFiles = journal.phase === 'committed'
    ? ownedAttemptFiles(journal.afterManifest)
    : null;
  assert.ok(Array.isArray(journal.payloads) && journal.payloads.length <= 32,
    'evidence operation journal has an invalid payload inventory');
  const destinations = new Set();
  const temporaries = new Set();
  for (const [index, payload] of journal.payloads.entries()) {
    const destination = safeManifestRelativePath(payload?.destination,
      'evidence operation destination');
    if (afterFiles !== null) {
      assert.ok(afterFiles.has(destination),
        `evidence operation destination is absent from its replacement manifest: ${destination}`);
    }
    assert.ok(destination !== 'manifest.json' && destination !== 'README.md',
      'evidence operation payload cannot replace an ownership file');
    assert.equal(destinations.has(destination), false,
      `evidence operation repeats destination ${destination}`);
    destinations.add(destination);
    const expectedTemporary = `.osg-evidence-payload-${journal.operationId}-${index}.tmp`;
    assert.equal(payload?.temporary, expectedTemporary,
      'evidence operation payload changed temporary identity');
    assert.equal(temporaries.has(expectedTemporary), false,
      'evidence operation repeats a temporary payload');
    temporaries.add(expectedTemporary);
    if (journal.phase === 'staging') {
      assert.equal(payload?.sha256, null,
        'staging evidence operation payload published a digest');
      assert.equal(payload?.size, null,
        'staging evidence operation payload published a size');
      assert.equal(payload?.before, null,
        'staging evidence operation payload published a prior identity');
    } else {
      assert.match(payload?.sha256 ?? '', /^[0-9a-f]{64}$/u,
        'evidence operation payload has an invalid digest');
      assert.ok(Number.isSafeInteger(payload?.size) && payload.size >= 0,
        'evidence operation payload has an invalid size');
    }
    if (journal.phase === 'committed' && payload.before !== null) {
      assert.match(payload?.before?.sha256 ?? '', /^[0-9a-f]{64}$/u,
        'evidence operation prior payload has an invalid digest');
      assert.ok(Number.isSafeInteger(payload?.before?.size) && payload.before.size >= 0,
        'evidence operation prior payload has an invalid size');
    }
    insideDirectory(directory, join(directory, ...destination.split('/')),
      'evidence operation destination');
  }
  return { afterFiles, temporaries };
};

export const recoverAttemptOperation = ({ workflow, attemptId, directory }) => {
  recoverAttemptManifestSidecar({ workflow, attemptId, directory });
  assertOwnedAttemptManifest({ workflow, attemptId, directory });
  const journalPath = attemptOperationJournalPath(directory);
  const journalSidecars = atomicSidecarsForTarget(journalPath);
  const payloadFiles = attemptOperationPayloadFiles(directory);
  let journal = existsSync(journalPath) ? readJson(journalPath) : null;

  if (journal === null && journalSidecars.length === 1) {
    try {
      const replacement = JSON.parse(readFileSync(journalSidecars[0], 'utf8'));
      validateAttemptOperationJournal({ journal: replacement, workflow, attemptId, directory });
    } catch {
      // A sidecar is not allocation authority. The writer cannot create its payload until the
      // journal's final rename returns, so retiring it never loses an owned payload authorization.
    }
    rmSync(journalSidecars[0]);
  } else if (journal !== null && journalSidecars.length === 1) {
    // A committed journal is authoritative. A sidecar can only be an interrupted attempt to write
    // that same single-owner journal and never authorizes a second operation.
    rmSync(journalSidecars[0]);
  }

  if (journal === null) {
    assert.equal(payloadFiles.length, 0,
      'evidence attempt has an unjournaled exact operation payload');
    return false;
  }

  assertOrdinaryPath(journalPath, 'file', 'evidence operation journal');
  const { temporaries } = validateAttemptOperationJournal({
    journal, workflow, attemptId, directory,
  });
  for (const payload of payloadFiles) {
    assert.ok(temporaries.has(payload.name),
      `evidence operation has an unjournaled payload: ${payload.name}`);
  }

  if (journal.phase === 'staging') {
    for (const payload of payloadFiles) rmSync(payload.path);
    rmSync(journalPath);
    return payloadFiles.length > 0;
  }

  const manifestPath = join(directory, 'manifest.json');
  const currentManifestBytes = readFileSync(manifestPath);
  const afterManifestBytes = Buffer.from(serializedManifest(journal.afterManifest));
  const currentDigest = sha256(currentManifestBytes);
  const afterDigest = sha256(afterManifestBytes);
  assert.ok(
    currentDigest === journal.beforeManifestSha256 || currentDigest === afterDigest,
    'evidence operation found a manifest outside its before/after transaction states',
  );

  for (const payload of journal.payloads) {
    const temporary = join(directory, payload.temporary);
    const destination = join(directory, ...payload.destination.split('/'));
    const temporaryExists = existsSync(temporary);
    const destinationExists = existsSync(destination);
    if (temporaryExists) assertFileIdentity(temporary, payload,
      `evidence operation temporary ${payload.temporary}`);
    if (destinationExists) {
      assertOrdinaryPath(destination, 'file', `evidence operation destination ${payload.destination}`);
      const identity = fileIdentity(destination);
      const isAfter = identity.sha256 === payload.sha256 && identity.size === payload.size;
      const isBefore = payload.before !== null
        && identity.sha256 === payload.before.sha256 && identity.size === payload.before.size;
      assert.ok(isAfter || (temporaryExists && isBefore),
        `evidence operation destination ${payload.destination} changed outside its transaction`);
      if (isAfter) {
        if (temporaryExists) rmSync(temporary);
        continue;
      }
    }
    assert.equal(temporaryExists, true,
      `evidence operation lost payload ${payload.temporary} before publication`);
    mkdirSync(dirname(destination), { recursive: true });
    if (destinationExists) rmSync(destination);
    renameSync(temporary, destination);
  }

  testCrashPoint('checkpoint-after-payload-publish');
  atomicWriteFile(manifestPath, afterManifestBytes);
  testCrashPoint('checkpoint-after-manifest');
  atomicWriteFile(join(directory, 'README.md'), attemptReadmeContents(journal.afterManifest));
  testCrashPoint('checkpoint-after-readme');
  rmSync(journalPath);
  return true;
};

const stagingAttemptOperationJournal = operation => ({
  schemaVersion: 1,
  publisher: EVIDENCE_PUBLISHER,
  workflow: operation.workflow,
  attemptId: operation.attemptId,
  operationId: operation.operationId,
  phase: 'staging',
  beforeManifestSha256: operation.beforeManifestSha256,
  afterManifest: null,
  payloads: operation.payloads.map(payload => ({
    temporary: payload.temporary,
    destination: payload.destination,
    sha256: null,
    size: null,
    before: null,
  })),
});

const publishStagingAttemptOperation = (operation) => {
  const journal = stagingAttemptOperationJournal(operation);
  validateAttemptOperationJournal({
    journal,
    workflow: operation.workflow,
    attemptId: operation.attemptId,
    directory: operation.directory,
  });
  atomicWriteFile(
    attemptOperationJournalPath(operation.directory),
    `${JSON.stringify(journal, null, 2)}\n`,
  );
};

export const createAttemptOperation = ({ workflow, attemptId, directory }) => {
  recoverAttemptOperation({ workflow, attemptId, directory });
  const record = assertOwnedAttemptManifest({ workflow, attemptId, directory });
  applyAtomicSidecarRepairs(inspectOwnedAttemptTree({
    directory,
    allowedFiles: ownedAttemptFiles(record.manifest),
  }));
  const operation = {
    workflow,
    attemptId,
    directory,
    operationId: randomBytes(16).toString('hex'),
    beforeManifestSha256: sha256(readFileSync(join(directory, 'manifest.json'))),
    payloads: [],
  };
  publishStagingAttemptOperation(operation);
  testCrashPoint('checkpoint-after-allocation-journal');
  return operation;
};

export const allocateAttemptOperationPayload = (operation, destination) => {
  const normalized = safeManifestRelativePath(destination, 'evidence operation destination');
  assert.equal(operation.payloads.some(payload => payload.destination === normalized), false,
    `evidence operation repeats destination ${normalized}`);
  const index = operation.payloads.length;
  assert.ok(index < 32, 'evidence operation exceeds its bounded payload count');
  const temporary = `.osg-evidence-payload-${operation.operationId}-${index}.tmp`;
  const path = join(operation.directory, temporary);
  assert.equal(existsSync(path), false, `evidence operation temporary already exists: ${temporary}`);
  const destinationPath = join(operation.directory, ...normalized.split('/'));
  operation.payloads.push({ destination: normalized, destinationPath, path, temporary, sealed: false });
  try {
    publishStagingAttemptOperation(operation);
  } catch (error) {
    operation.payloads.pop();
    throw error;
  }
  return path;
};

export const sealAttemptOperationPayload = (operation, path) => {
  const payload = operation.payloads.find(candidate => samePath(candidate.path, path));
  assert.ok(payload, 'evidence operation tried to seal an unknown payload');
  assert.equal(payload.sealed, false, 'evidence operation payload was sealed twice');
  assertOrdinaryPath(path, 'file', `evidence operation staged ${payload.destination}`);
  const descriptor = openRetryingOnScan(path, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const identity = fileIdentity(path);
  payload.sha256 = identity.sha256;
  payload.size = identity.size;
  payload.before = existsSync(payload.destinationPath) ? fileIdentity(payload.destinationPath) : null;
  payload.sealed = true;
  return payload;
};

const abandonAttemptOperationPayload = (operation, path) => {
  const index = operation.payloads.findIndex(candidate => samePath(candidate.path, path));
  assert.ok(index >= 0, 'evidence operation tried to abandon an unknown payload');
  assert.equal(index, operation.payloads.length - 1,
    'evidence operation can abandon only its newest payload');
  rmSync(path, { force: true });
  operation.payloads.pop();
  publishStagingAttemptOperation(operation);
};

export const stageAttemptOperationContents = (operation, destination, contents) => {
  const path = allocateAttemptOperationPayload(operation, destination);
  let descriptor = null;
  let sealed = false;
  try {
    descriptor = openRetryingOnScan(path, 'wx', 0o600);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    sealAttemptOperationPayload(operation, path);
    sealed = true;
    return path;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (!sealed) abandonAttemptOperationPayload(operation, path);
  }
};

export const discardUncommittedAttemptOperation = (operation) => {
  const journalPath = attemptOperationJournalPath(operation.directory);
  if (!existsSync(journalPath)) return;
  const journal = readJson(journalPath);
  validateAttemptOperationJournal({
    journal,
    workflow: operation.workflow,
    attemptId: operation.attemptId,
    directory: operation.directory,
  });
  if (journal.phase === 'committed') return;
  assert.equal(journal.operationId, operation.operationId,
    'evidence operation cleanup encountered another owner');
  const authorized = new Set(journal.payloads.map(payload => payload.temporary));
  for (const payload of attemptOperationPayloadFiles(operation.directory)) {
    assert.ok(authorized.has(payload.name),
      `evidence operation cleanup found an unjournaled payload: ${payload.name}`);
    rmSync(payload.path);
  }
  rmSync(journalPath);
};

export const writeManifest = (manifest, { operation = null } = {}) => {
  const workflow = manifest.workflow;
  const attemptId = manifest.attempt.id;
  const directory = attemptDirectory(workflow, attemptId);
  const publication = operation ?? createAttemptOperation({ workflow, attemptId, directory });
  assert.equal(publication.workflow, workflow, 'evidence operation changed workflow');
  assert.equal(publication.attemptId, attemptId, 'evidence operation changed attempt');
  assert.equal(samePath(publication.directory, directory), true,
    'evidence operation changed attempt directory');
  assert.equal(publication.payloads.every(payload => payload.sealed), true,
    'evidence operation contains an unsealed payload');

  const manifestPath = join(directory, 'manifest.json');
  const beforeManifestBytes = readFileSync(manifestPath);
  assert.equal(sha256(beforeManifestBytes), publication.beforeManifestSha256,
    'evidence operation started from a different manifest version');
  const journal = {
    schemaVersion: 1,
    publisher: EVIDENCE_PUBLISHER,
    workflow,
    attemptId,
    operationId: publication.operationId,
    phase: 'committed',
    beforeManifestSha256: publication.beforeManifestSha256,
    afterManifest: manifest,
    payloads: publication.payloads.map((payload) => ({
      temporary: payload.temporary,
      destination: payload.destination,
      sha256: payload.sha256,
      size: payload.size,
      before: payload.before,
    })),
  };
  validateAttemptOperationJournal({ journal, workflow, attemptId, directory });
  const journalPath = attemptOperationJournalPath(directory);
  let committedJournalPublished = false;
  try {
    testCrashPoint('checkpoint-after-payload-stage');
    atomicWriteFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    committedJournalPublished = true;
    testCrashPoint('checkpoint-after-journal');
    recoverAttemptOperation({ workflow, attemptId, directory });
  } finally {
    if (!committedJournalPublished) discardUncommittedAttemptOperation(publication);
  }
};
