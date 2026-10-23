// Attempt discovery: manifests, publication-temporary recovery, and the latest-success pointer.

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  applyAtomicSidecarRepairs, assertOrdinaryPath, assertOrdinaryTemporaryTree,
  atomicSidecarsForTarget, inspectOwnedAttemptTree, readJson,
} from './files.js';
import { assertOwnedAttemptManifest, ownedAttemptFiles } from './manifest.js';
import { recoverAttemptOperation } from './operation.js';
import {
  ATTEMPT_ID_PATTERN, attemptDirectory, EVIDENCE_PUBLISHER, workflowEvidenceDirectory,
} from './paths.js';

const ATTEMPT_PUBLICATION_TEMP_PATTERN = /^\.osg-attempt-(\d{17}-\d{1,10}-[0-9a-f]{8})-([0-9a-f]{24})\.tmp$/u;
export const ATTEMPT_PUBLICATION_JOURNAL = '.osg-attempt-publication.json';
export const readAttemptManifest = (workflow, attemptId) => {
  const directory = attemptDirectory(workflow, attemptId);
  if (existsSync(directory)) recoverAttemptOperation({ workflow, attemptId, directory });
  const path = join(directory, 'manifest.json');
  const manifest = readJson(path);
  assert.ok(manifest, `workflow evidence attempt was not initialized: ${path}`);
  return manifest;
};

export const validateAttemptPublicationJournal = ({ journal, workflow }) => {
  assert.equal(journal?.schemaVersion, 1,
    `${workflow} attempt-publication journal has an unknown schema`);
  assert.equal(journal?.publisher, EVIDENCE_PUBLISHER,
    `${workflow} attempt-publication journal has an unknown publisher`);
  assert.equal(journal?.workflow, workflow,
    `${workflow} attempt-publication journal changed workflow`);
  assert.match(journal?.attemptId ?? '', ATTEMPT_ID_PATTERN,
    `${workflow} attempt-publication journal has an invalid attempt`);
  const match = ATTEMPT_PUBLICATION_TEMP_PATTERN.exec(journal?.temporary ?? '');
  assert.ok(match && match[1] === journal.attemptId,
    `${workflow} attempt-publication journal changed its temporary identity`);
  return journal;
};

export const recoverAttemptPublicationTemporaries = (workflow) => {
  const root = join(workflowEvidenceDirectory(workflow), 'attempts');
  if (!existsSync(root)) return 0;
  assertOrdinaryPath(root, 'directory', `${workflow} attempts root`);
  const temporaries = readdirSync(root, { withFileTypes: true })
    .filter(entry => (
      entry.name !== ATTEMPT_PUBLICATION_JOURNAL && entry.name.startsWith('.osg-attempt-')
    ))
    .map((entry) => {
    const match = ATTEMPT_PUBLICATION_TEMP_PATTERN.exec(entry.name);
    assert.ok(
      match && ATTEMPT_ID_PATTERN.test(match[1]) && entry.isDirectory() && !entry.isSymbolicLink(),
      `${workflow} attempts contain an unknown publication temporary: ${entry.name}`,
    );
    const path = join(root, entry.name);
    assertOrdinaryTemporaryTree(path, `${workflow} attempt publication temporary`);
      return { name: entry.name, path };
    });
  const journalPath = join(root, ATTEMPT_PUBLICATION_JOURNAL);
  const sidecars = atomicSidecarsForTarget(journalPath);
  let journal = existsSync(journalPath) ? readJson(journalPath) : null;
  if (journal === null && sidecars.length === 1) {
    try {
      const replacement = JSON.parse(readFileSync(sidecars[0], 'utf8'));
      validateAttemptPublicationJournal({ journal: replacement, workflow });
    } catch {
      // An unpublished journal sidecar cannot authorize deletion. It is safe to retire because the
      // writer creates the temporary directory only after the final journal rename returns.
    }
    rmSync(sidecars[0]);
  } else if (journal !== null && sidecars.length === 1) {
    rmSync(sidecars[0]);
  }
  if (journal === null) {
    assert.equal(temporaries.length, 0,
      `${workflow} has an unjournaled attempt publication temporary`);
    return 0;
  }

  assertOrdinaryPath(journalPath, 'file', `${workflow} attempt-publication journal`);
  validateAttemptPublicationJournal({ journal, workflow });
  assert.ok(temporaries.every(temporary => temporary.name === journal.temporary),
    `${workflow} has an unjournaled attempt publication temporary`);
  assert.ok(temporaries.length <= 1,
    `${workflow} has multiple attempt publication temporaries`);
  const finalDirectory = attemptDirectory(workflow, journal.attemptId);
  const temporary = temporaries.find(candidate => candidate.name === journal.temporary) ?? null;
  assert.equal(temporary !== null && existsSync(finalDirectory), false,
    `${workflow} attempt exists as both a final and temporary publication`);
  if (temporary !== null) rmSync(temporary.path, { recursive: true });
  else if (existsSync(finalDirectory)) {
    const record = assertOwnedAttemptManifest({
      workflow, attemptId: journal.attemptId, directory: finalDirectory,
    });
    applyAtomicSidecarRepairs(inspectOwnedAttemptTree({
      directory: finalDirectory,
      allowedFiles: ownedAttemptFiles(record.manifest),
    }));
  }
  rmSync(journalPath);
  return temporary === null ? 0 : 1;
};

export const attemptRecords = (workflow) => {
  const root = join(workflowEvidenceDirectory(workflow), 'attempts');
  if (!existsSync(root)) return [];
  assertOrdinaryPath(root, 'directory', `${workflow} attempts root`);
  recoverAttemptPublicationTemporaries(workflow);
  return readdirSync(root, { withFileTypes: true })
    .map((entry) => {
      assert.equal(
        entry.isDirectory() && !entry.isSymbolicLink(),
        true,
        `${workflow} attempts contain an unknown or redirected entry: ${entry.name}`,
      );
      assert.match(entry.name, ATTEMPT_ID_PATTERN,
        `${workflow} attempts contain an unknown entry name`);
      recoverAttemptOperation({
        workflow,
        attemptId: entry.name,
        directory: join(root, entry.name),
      });
      return assertOwnedAttemptManifest({
        workflow,
        attemptId: entry.name,
        directory: join(root, entry.name),
      });
    })
    .sort((left, right) => (
      right.manifest.attempt.startedAt.localeCompare(left.manifest.attempt.startedAt)
      || right.manifest.attempt.id.localeCompare(left.manifest.attempt.id)
    ));
};

export const readLatestSuccessPointer = (workflow) => {
  const pointerPath = join(workflowEvidenceDirectory(workflow), 'latest-success.json');
  if (!existsSync(pointerPath)) return { attemptId: null, pointer: null };
  assertOrdinaryPath(pointerPath, 'file', `${workflow} latest-success pointer`);
  const pointer = readJson(pointerPath);
  assert.equal(pointer?.schemaVersion, 1, `${workflow} latest-success pointer has an unknown schema`);
  assert.equal(pointer?.workflow, workflow, `${workflow} latest-success pointer changed workflow`);
  assert.match(pointer?.attemptId ?? '', ATTEMPT_ID_PATTERN,
    `${workflow} latest-success pointer has an unknown attempt`);
  assert.equal(pointer?.path, `attempts/${pointer.attemptId}`,
    `${workflow} latest-success pointer changed path`);
  return { attemptId: pointer.attemptId, pointer };
};

const validLatestSuccessPointer = (pointer, workflow) => (
  pointer?.schemaVersion === 1
    && pointer?.workflow === workflow
    && ATTEMPT_ID_PATTERN.test(pointer?.attemptId ?? '')
    && pointer?.path === `attempts/${pointer.attemptId}`
    && !Number.isNaN(Date.parse(pointer?.endedAt))
);

export const recoverLatestSuccessSidecar = (workflow) => {
  const path = join(workflowEvidenceDirectory(workflow), 'latest-success.json');
  const [sidecar] = atomicSidecarsForTarget(path);
  if (sidecar === undefined) return false;
  let replacement = null;
  try {
    replacement = JSON.parse(readFileSync(sidecar, 'utf8'));
  } catch {
    // An incomplete exact pointer sidecar never authorizes an attempt deletion.
  }
  const current = existsSync(path) ? readJson(path) : null;
  if (!validLatestSuccessPointer(replacement, workflow)) {
    assert.ok(validLatestSuccessPointer(current, workflow),
      `${workflow} has no valid latest-success pointer beside its incomplete sidecar`);
    rmSync(sidecar);
    return true;
  }
  if (
    current === null
    || !validLatestSuccessPointer(current, workflow)
    || Date.parse(replacement.endedAt) >= Date.parse(current.endedAt)
  ) {
    renameSync(sidecar, path);
  } else {
    rmSync(sidecar);
  }
  return true;
};

export const latestSuccessfulAttemptId = (workflow, records) => {
  const { attemptId } = readLatestSuccessPointer(workflow);
  if (attemptId === null) return null;
  const record = records.find(({ manifest }) => manifest.attempt.id === attemptId);
  assert.ok(record, `${workflow} latest-success pointer names a missing attempt`);
  assert.equal(record.manifest.attempt.outcome, 'pass',
    `${workflow} latest-success pointer does not name a passing attempt`);
  return attemptId;
};
