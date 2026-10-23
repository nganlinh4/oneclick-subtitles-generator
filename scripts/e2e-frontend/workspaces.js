'use strict';

// Lease-owned frontend build workspaces inside the managed cache, with journals that let a later
// lease holder recover a workspace interrupted by a hard stop.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const { isWithin, resolveAbsoluteInput, samePath } = require('../publication-paths');
const { assertManagedMutationAuthority, readExactJsonFile, reassertMutationAuthority } = require('./authority');
const { ID_PATTERN, MANAGED_CACHE_OWNER, SNAPSHOT_SCHEMA_VERSION } = require('./constants');
const {
  assertDirectChild,
  ensurePublisherLayout,
  journalBytes,
  recoverPublisherTransactions,
  removeOwnedPath,
} = require('./layout');

const workspaceJournalKeys = [
  'schemaVersion',
  'owner',
  'rootId',
  'leaseId',
  'processId',
  'workspaceId',
  'directoryLeaf',
];

const workspaceJournalPath = (workspacesRoot, workspaceId) => (
  path.join(workspacesRoot, `workspace-${workspaceId}.json`)
);

const readWorkspaceJournal = (workspacesRoot, workspaceId) => {
  const journalPath = workspaceJournalPath(workspacesRoot, workspaceId);
  const journal = readExactJsonFile(
    journalPath,
    'frontend build workspace journal',
    workspaceJournalKeys,
  );
  if (
    journal.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || journal.owner !== MANAGED_CACHE_OWNER
    || !ID_PATTERN.test(journal.rootId ?? '')
    || !ID_PATTERN.test(journal.leaseId ?? '')
    || !Number.isInteger(journal.processId)
    || journal.processId < 1
    || journal.workspaceId !== workspaceId
    || journal.directoryLeaf !== `workspace-${workspaceId}`
  ) {
    throw new Error(`frontend build workspace journal is invalid: ${journalPath}`);
  }
  return Object.freeze({ journal, journalPath });
};

const recoverFrontendWorkspaces = (cacheRoot, roots, authority) => {
  const journals = new Map();
  const directories = new Map();
  for (const child of fs.readdirSync(roots.workspacesRoot, { withFileTypes: true })) {
    const atomicMatch = /^\.new-workspace-([0-9a-f]{32})\.json$/u.exec(child.name);
    if (atomicMatch !== null) {
      if (!child.isFile() || child.isSymbolicLink()) {
        throw new Error(`frontend workspace journal temporary has the wrong type: ${child.name}`);
      }
      reassertMutationAuthority(cacheRoot, authority);
      removeOwnedPath(path.join(roots.workspacesRoot, child.name), 'frontend workspace journal temporary');
      continue;
    }
    const journalMatch = /^workspace-([0-9a-f]{32})\.json$/u.exec(child.name);
    if (journalMatch !== null && child.isFile() && !child.isSymbolicLink()) {
      journals.set(journalMatch[1], child.name);
      continue;
    }
    const directoryMatch = /^workspace-([0-9a-f]{32})$/u.exec(child.name);
    if (directoryMatch !== null && child.isDirectory() && !child.isSymbolicLink()) {
      directories.set(directoryMatch[1], child.name);
      continue;
    }
    throw new Error(`unrecognized frontend build workspace entry: ${child.name}`);
  }
  for (const [workspaceId, journalLeaf] of journals) {
    const { journal, journalPath } = readWorkspaceJournal(roots.workspacesRoot, workspaceId);
    if (journal.rootId !== authority.rootId) {
      throw new Error(`frontend build workspace belongs to a different cache root: ${journalLeaf}`);
    }
    if (journal.leaseId === authority.leaseId) {
      throw new Error(`the active E2E lease already owns an unfinished frontend workspace: ${journal.directoryLeaf}`);
    }
    const directory = path.join(roots.workspacesRoot, journal.directoryLeaf);
    assertDirectChild(
      roots.workspacesRoot,
      directory,
      journal.directoryLeaf,
      'frontend build workspace recovery path',
    );
    reassertMutationAuthority(cacheRoot, authority);
    removeOwnedPath(directory, 'interrupted frontend build workspace', true);
    removeOwnedPath(journalPath, 'frontend build workspace journal');
    directories.delete(workspaceId);
  }
  if (directories.size !== 0) {
    throw new Error(
      `frontend build workspace has no ownership journal: ${[...directories.values()].join(', ')}`,
    );
  }
};

const createManagedFrontendWorkspace = ({ cacheRoot, retentionLeaseId }) => {
  const cache = resolveAbsoluteInput(cacheRoot, 'managed frontend cache root');
  const authority = assertManagedMutationAuthority(cache, retentionLeaseId);
  if (authority === null) throw new Error('frontend build workspace requires a managed frontend cache lane');
  const roots = ensurePublisherLayout(cache, authority);
  recoverPublisherTransactions(cache, roots, authority);
  recoverFrontendWorkspaces(cache, roots, authority);
  const workspaceId = randomBytes(16).toString('hex');
  const directoryLeaf = `workspace-${workspaceId}`;
  const directory = path.join(roots.workspacesRoot, directoryLeaf);
  const journalPath = workspaceJournalPath(roots.workspacesRoot, workspaceId);
  const temporaryJournal = path.join(roots.workspacesRoot, `.new-workspace-${workspaceId}.json`);
  const bytes = journalBytes({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    owner: MANAGED_CACHE_OWNER,
    rootId: authority.rootId,
    leaseId: authority.leaseId,
    processId: process.pid,
    workspaceId,
    directoryLeaf,
  });
  reassertMutationAuthority(cache, authority);
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryJournal, 'wx');
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally {
      const openDescriptor = descriptor;
      descriptor = undefined;
      fs.closeSync(openDescriptor);
    }
    fs.renameSync(temporaryJournal, journalPath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryJournal)) fs.rmSync(temporaryJournal, { force: true });
  }
  try {
    fs.mkdirSync(directory, { recursive: false });
  } catch (error) {
    // The directory was never ours if creation failed. Remove only our exact journal and preserve
    // any colliding bytes for inspection.
    if (fs.existsSync(journalPath)) fs.rmSync(journalPath, { force: true });
    throw error;
  }
  return Object.freeze({
    cacheRoot: cache,
    rootId: authority.rootId,
    leaseId: authority.leaseId,
    workspaceId,
    workspaceRoot: directory,
    journalPath,
  });
};

const releaseManagedFrontendWorkspace = (workspace) => {
  if (
    workspace === null
    || typeof workspace !== 'object'
    || !ID_PATTERN.test(workspace.workspaceId ?? '')
    || !ID_PATTERN.test(workspace.rootId ?? '')
    || !ID_PATTERN.test(workspace.leaseId ?? '')
  ) {
    throw new Error('frontend build workspace release requires its exact creation contract');
  }
  const cache = resolveAbsoluteInput(workspace.cacheRoot, 'managed frontend cache root');
  const authority = assertManagedMutationAuthority(cache, workspace.leaseId);
  if (authority === null || authority.rootId !== workspace.rootId) {
    throw new Error('frontend build workspace release does not own the managed lane');
  }
  const roots = ensurePublisherLayout(cache, authority);
  const { journal, journalPath } = readWorkspaceJournal(roots.workspacesRoot, workspace.workspaceId);
  if (
    journal.rootId !== workspace.rootId
    || journal.leaseId !== workspace.leaseId
    || journal.processId !== process.pid
    || !samePath(journalPath, workspace.journalPath)
    || !samePath(path.join(roots.workspacesRoot, journal.directoryLeaf), workspace.workspaceRoot)
  ) {
    throw new Error('frontend build workspace release contract changed');
  }
  reassertMutationAuthority(cache, authority);
  removeOwnedPath(workspace.workspaceRoot, 'frontend build workspace', true);
  removeOwnedPath(journalPath, 'frontend build workspace journal');
};

const isOwnedManagedWorkspaceSource = (source, roots, authority) => {
  if (authority === null || !isWithin(roots.workspacesRoot, source)) return false;
  const relative = path.relative(roots.workspacesRoot, source);
  const [directoryLeaf] = relative.split(path.sep);
  const match = /^workspace-([0-9a-f]{32})$/u.exec(directoryLeaf);
  if (match === null) return false;
  const workspaceRoot = path.join(roots.workspacesRoot, directoryLeaf);
  if (!samePath(workspaceRoot, source) && !isWithin(workspaceRoot, source)) return false;
  const { journal } = readWorkspaceJournal(roots.workspacesRoot, match[1]);
  return journal.rootId === authority.rootId
    && journal.leaseId === authority.leaseId
    && journal.processId === process.pid;
};

module.exports = {
  createManagedFrontendWorkspace,
  isOwnedManagedWorkspaceSource,
  releaseManagedFrontendWorkspace,
};
