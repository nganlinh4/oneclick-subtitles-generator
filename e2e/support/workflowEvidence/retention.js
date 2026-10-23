// Journal-authorized retention: the three newest attempts plus the latest successful proof.

import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  attemptRecords, latestSuccessfulAttemptId, readLatestSuccessPointer,
  recoverLatestSuccessSidecar,
} from './attempts.js';
import {
  applyAtomicSidecarRepairs, assertOrdinaryPath, atomicWriteFile, inspectOwnedAttemptTree,
  readJson, recoverAtomicSidecarsForTarget,
} from './files.js';
import {
  assertOwnedAttemptManifest, ownedAttemptFiles, safeManifestRelativePath,
} from './manifest.js';
import {
  ATTEMPT_ID_PATTERN, EVIDENCE_PUBLISHER, safeSegment, workflowEvidenceDirectory,
} from './paths.js';

const RECENT_ATTEMPT_RETENTION = 3;
const RETENTION_TRASH_DIRECTORY = '.osg-workflow-evidence-trash';
const RETENTION_TRASH_PATTERN = /^(\d{17}-\d{1,10}-[0-9a-f]{8})\.([0-9a-f]{12})$/u;
const RETENTION_JOURNAL = '.osg-workflow-evidence-retention.json';
const RETENTION_JOURNAL_SIDECAR_PATTERN = /^\.\.osg-workflow-evidence-retention\.json\.\d{1,10}\.[0-9a-f]{12}\.tmp$/u;
const retentionJournalSidecars = (workflow) => {
  const root = workflowEvidenceDirectory(workflow);
  const prefix = `.${RETENTION_JOURNAL}.`;
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.name.startsWith(prefix))
    .map((entry) => {
      assert.ok(
        RETENTION_JOURNAL_SIDECAR_PATTERN.test(entry.name)
          && entry.isFile()
          && !entry.isSymbolicLink(),
        `${workflow} has an unknown retention-journal sidecar: ${entry.name}`,
      );
      const path = join(root, entry.name);
      assertOrdinaryPath(path, 'file', `${workflow} retention-journal sidecar`);
      return path;
    });
};

const readRetentionJournal = (workflow) => {
  const path = join(workflowEvidenceDirectory(workflow), RETENTION_JOURNAL);
  const sidecars = retentionJournalSidecars(workflow);
  if (!existsSync(path)) return { journal: null, path, sidecars };
  assertOrdinaryPath(path, 'file', `${workflow} evidence retention journal`);
  const journal = readJson(path);
  assert.equal(journal?.schemaVersion, 1, `${workflow} retention journal has an unknown schema`);
  assert.equal(journal?.publisher, EVIDENCE_PUBLISHER,
    `${workflow} retention journal is not publisher-owned`);
  assert.equal(journal?.workflow, workflow, `${workflow} retention journal changed workflow`);
  assert.ok(
    journal.latestSuccessAttemptId === null
      || ATTEMPT_ID_PATTERN.test(journal.latestSuccessAttemptId),
    `${workflow} retention journal has an invalid protected success`,
  );
  assert.ok(Array.isArray(journal.operations) && journal.operations.length > 0,
    `${workflow} retention journal has no bounded operations`);
  const identities = new Set();
  for (const operation of journal.operations) {
    assert.match(operation?.attemptId ?? '', ATTEMPT_ID_PATTERN,
      `${workflow} retention journal has an invalid attempt`);
    assert.equal(operation.sourceName, operation.attemptId,
      `${workflow} retention journal changed its source`);
    const match = RETENTION_TRASH_PATTERN.exec(operation.trashName ?? '');
    assert.equal(match?.[1], operation.attemptId, `${workflow} retention journal changed its trash`);
    assert.equal(identities.has(operation.attemptId), false,
      `${workflow} retention journal repeats an attempt`);
    identities.add(operation.attemptId);
    assert.notEqual(operation.attemptId, journal.latestSuccessAttemptId,
      `${workflow} retention journal selected the latest success`);
    assert.ok(Array.isArray(operation.allowedFiles) && operation.allowedFiles.length >= 2,
      `${workflow} retention journal has no file inventory`);
    const reviewed = new Set(operation.allowedFiles.map((file) => (
      safeManifestRelativePath(file, `${workflow} retention journal file`)
    )));
    assert.equal(reviewed.size, operation.allowedFiles.length,
      `${workflow} retention journal repeats a file`);
    assert.ok(reviewed.has('manifest.json') && reviewed.has('README.md'),
      `${workflow} retention journal omits its ownership files`);
  }
  return { journal, path, sidecars };
};

const recoverRetentionJournal = (workflow) => {
  const workflowRoot = workflowEvidenceDirectory(workflow);
  recoverAtomicSidecarsForTarget(join(workflowRoot, 'README.md'));
  recoverLatestSuccessSidecar(workflow);
  const state = readRetentionJournal(workflow);
  const trashRoot = join(workflowRoot, RETENTION_TRASH_DIRECTORY);
  if (state.journal === null) {
    assert.equal(existsSync(trashRoot), false,
      `${workflow} has retention trash without its publisher journal`);
    // An exact atomic sidecar precedes every destructive step. With no published journal there is
    // nothing to recover and no evidence mutation could have started, so these are safe to retire.
    for (const sidecar of state.sidecars) rmSync(sidecar);
    return 0;
  }

  const { attemptId: currentLatestSuccess } = readLatestSuccessPointer(workflow);
  assert.equal(currentLatestSuccess, state.journal.latestSuccessAttemptId,
    `${workflow} latest-success changed during retention recovery`);
  const attemptsRoot = join(workflowRoot, 'attempts');
  assertOrdinaryPath(attemptsRoot, 'directory', `${workflow} attempts root`);
  if (existsSync(trashRoot)) assertOrdinaryPath(trashRoot, 'directory', `${workflow} retention trash`);
  const expectedTrash = new Set(state.journal.operations.map(operation => operation.trashName));
  if (existsSync(trashRoot)) {
    for (const entry of readdirSync(trashRoot, { withFileTypes: true })) {
      assert.ok(expectedTrash.has(entry.name) && entry.isDirectory() && !entry.isSymbolicLink(),
        `${workflow} retention trash contains an unknown or redirected entry: ${entry.name}`);
    }
  }

  const recoveries = [];
  const operations = state.journal.operations.map((operation) => {
    const source = join(attemptsRoot, operation.sourceName);
    const trash = join(trashRoot, operation.trashName);
    const sourceExists = existsSync(source);
    const trashExists = existsSync(trash);
    assert.equal(sourceExists && trashExists, false,
      `${workflow} retention attempt exists in source and trash simultaneously`);
    const allowedFiles = new Set(operation.allowedFiles);
    if (sourceExists) {
      const record = assertOwnedAttemptManifest({
        workflow, attemptId: operation.attemptId, directory: source,
      });
      assert.deepEqual([...ownedAttemptFiles(record.manifest)].sort(), [...allowedFiles].sort(),
        `${workflow} retention source inventory changed after journaling`);
      recoveries.push(...inspectOwnedAttemptTree({ directory: source, allowedFiles }));
    } else if (trashExists) {
      recoveries.push(...inspectOwnedAttemptTree({
        directory: trash, allowedFiles, allowMissing: true,
      }));
    }
    return { ...operation, source, sourceExists, trash, trashExists };
  });
  applyAtomicSidecarRepairs(recoveries);
  for (const sidecar of state.sidecars) rmSync(sidecar);

  if (!existsSync(trashRoot) && operations.some(operation => operation.sourceExists)) {
    mkdirSync(trashRoot);
    assertOrdinaryPath(trashRoot, 'directory', `${workflow} retention trash`);
  }
  for (const operation of operations) {
    if (operation.sourceExists) renameSync(operation.source, operation.trash);
    if (operation.sourceExists || operation.trashExists) {
      rmSync(operation.trash, { recursive: true });
    }
  }
  if (existsSync(trashRoot) && readdirSync(trashRoot).length === 0) rmdirSync(trashRoot);
  rmSync(state.path); // The authorization survives until every journaled deletion is complete.
  return operations.length;
};

/**
 * Keep the newest three attempts plus the latest successful proof. Cleanup runs only after every
 * candidate and prior quarantine child has proved its schema, identity, exact inventory and
 * non-reparse tree; one unknown byte therefore prevents every mutation in this pass.
 */
export const applyWorkflowEvidenceRetention = (workflow) => {
  safeSegment(workflow, 'workflow');
  recoverRetentionJournal(workflow);
  const records = attemptRecords(workflow);
  const latestSuccess = latestSuccessfulAttemptId(workflow, records);
  const protectedIds = new Set(records.slice(0, RECENT_ATTEMPT_RETENTION)
    .map(({ manifest }) => manifest.attempt.id));
  if (latestSuccess !== null) protectedIds.add(latestSuccess);
  const removals = records.filter(({ manifest }) => !protectedIds.has(manifest.attempt.id));
  const repairs = [];
  // Validate every retained and removable attempt before changing even an orphaned atomic sidecar.
  for (const record of records) {
    repairs.push(...inspectOwnedAttemptTree({
      directory: record.directory,
      allowedFiles: ownedAttemptFiles(record.manifest),
    }));
  }
  applyAtomicSidecarRepairs(repairs);
  if (removals.length === 0) return { retained: records.length, removed: 0 };

  const workflowRoot = workflowEvidenceDirectory(workflow);
  const trashRoot = join(workflowRoot, RETENTION_TRASH_DIRECTORY);
  const journalPath = join(workflowRoot, RETENTION_JOURNAL);
  const journal = {
    schemaVersion: 1,
    publisher: EVIDENCE_PUBLISHER,
    workflow,
    latestSuccessAttemptId: latestSuccess,
    operations: removals.map((record) => ({
      attemptId: record.manifest.attempt.id,
      sourceName: record.manifest.attempt.id,
      trashName: `${record.manifest.attempt.id}.${randomBytes(6).toString('hex')}`,
      allowedFiles: [...ownedAttemptFiles(record.manifest)].sort(),
    })),
  };
  atomicWriteFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  mkdirSync(trashRoot);
  assertOrdinaryPath(trashRoot, 'directory', `${workflow} evidence retention trash`);
  let removed = 0;
  for (const operation of journal.operations) {
    const source = join(workflowRoot, 'attempts', operation.sourceName);
    const quarantined = join(trashRoot, operation.trashName);
    renameSync(source, quarantined);
    rmSync(quarantined, { recursive: true });
    removed += 1;
  }
  if (readdirSync(trashRoot).length === 0) rmdirSync(trashRoot);
  rmSync(journalPath);
  return { retained: records.length - removed, removed };
};
