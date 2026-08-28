import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename, dirname, isAbsolute, join, relative, resolve, sep,
} from 'node:path';
import process from 'node:process';

import {
  APPLICATION_BINARY, EVIDENCE_CACHE_ROOT, REPOSITORY_ROOT,
} from './environment.js';

/* global browser, document, getComputedStyle, window */

const TEST_EVIDENCE_OVERRIDE = 'OSG_E2E_WORKFLOW_EVIDENCE_ROOT';
const evidenceRootForProcess = () => {
  const requested = process.env[TEST_EVIDENCE_OVERRIDE];
  if (requested === undefined) return EVIDENCE_CACHE_ROOT;
  if (process.env.NODE_TEST_CONTEXT === undefined) {
    throw new Error(`${TEST_EVIDENCE_OVERRIDE} is available only to a Node test subprocess`);
  }
  if (
    !isAbsolute(requested)
    || requested.split(/[\\/]+/u).some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`${TEST_EVIDENCE_OVERRIDE} must be an absolute traversal-free test path`);
  }
  const status = lstatSync(requested);
  const canonical = realpathSync.native(requested);
  const temporary = realpathSync.native(tmpdir());
  const same = (left, right) => (
    process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  );
  if (
    !status.isDirectory()
    || status.isSymbolicLink()
    || !same(dirname(canonical), temporary)
    || !basename(canonical).startsWith('osg-workflow-evidence-test-')
  ) {
    throw new Error(`${TEST_EVIDENCE_OVERRIDE} must be one private direct child of the OS temp root`);
  }
  return canonical;
};

export const WORKFLOW_EVIDENCE_ROOT = evidenceRootForProcess();
const ATTEMPT_ENVIRONMENT_KEY = 'OSG_E2E_EVIDENCE_ATTEMPT';
const ATTEMPT_ID_PATTERN = /^\d{17}-\d{1,10}-[0-9a-f]{8}$/u;
const EVIDENCE_PUBLISHER = 'osg-e2e-workflow-evidence';
const RECENT_ATTEMPT_RETENTION = 3;
const RETENTION_TRASH_DIRECTORY = '.osg-workflow-evidence-trash';
const RETENTION_TRASH_PATTERN = /^(\d{17}-\d{1,10}-[0-9a-f]{8})\.([0-9a-f]{12})$/u;
const RETENTION_JOURNAL = '.osg-workflow-evidence-retention.json';
const RETENTION_JOURNAL_SIDECAR_PATTERN = /^\.\.osg-workflow-evidence-retention\.json\.\d{1,10}\.[0-9a-f]{12}\.tmp$/u;
const ATOMIC_SIDECAR_PATTERN = /^\.(.+)\.\d{1,10}\.([0-9a-f]{12})\.tmp$/u;
const ATTEMPT_PUBLICATION_TEMP_PATTERN = /^\.osg-attempt-(\d{17}-\d{1,10}-[0-9a-f]{8})-([0-9a-f]{24})\.tmp$/u;
const ATTEMPT_PUBLICATION_JOURNAL = '.osg-attempt-publication.json';
const ATTEMPT_OPERATION_JOURNAL = '.osg-evidence-operation.json';
const ATTEMPT_OPERATION_PAYLOAD_PATTERN = /^\.osg-evidence-payload-([0-9a-f]{32})-(\d{1,3})\.tmp$/u;
const TEST_CRASH_POINT_ENVIRONMENT_KEY = 'OSG_E2E_TEST_EVIDENCE_CRASH_POINT';
const MAX_DIRTY_ENTRIES = 200;
const MAX_BROWSER_LOGS = 100;
const MAX_BROWSER_LOG_MESSAGE = 2_000;
const MAX_APP_LOG_FILES = 8;
const MAX_APP_LOG_TAIL_BYTES = 16 * 1024;
const MAX_TEST_FAILURES = 8;
const MAX_TEST_FAILURE_TITLE = 1_000;
const MAX_TEST_FAILURE_CONTEXT = 2_000;
const MAX_TEST_FAILURE_MESSAGE = 4_000;
const MAX_TEST_FAILURE_STACK = 16 * 1024;
const MAX_ATTEMPT_FAILURE = 2_000;
const MIN_SCREENSHOT_BYTES = 1_000;
const MAX_CAPTURED_HORIZONTAL_SCROLL_PX = 1_000_000;

export const workflowNameForJourney = (journey) => basename(journey, '.journey.js')
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  .toLowerCase();

const safeSegment = (value, label) => {
  assert.match(value, /^[a-z0-9][a-z0-9-]{0,79}$/, `${label} must be a bounded slug`);
  return value;
};

export const workflowFailureStepForTest = (title) => {
  assert.equal(typeof title, 'string', 'failure evidence requires a test title');
  const readable = title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '') || 'test';
  const digest = createHash('sha256').update(title).digest('hex').slice(0, 8);
  return safeSegment(`failure-${readable}-${digest}`, 'step');
};

// A failed provider request can echo the URL or authorization header that caused it. Preserve the
// exact assertion and stack around those values, but never turn immutable test evidence into a
// credential store. Work is capped before the regex pass as well as after it so a hostile Error
// object cannot make evidence serialization unbounded.
const boundedFailureText = (value, maximum) => {
  const raw = value === undefined || value === null ? '' : String(value);
  const boundedInput = raw.slice(0, maximum * 4);
  const redacted = boundedInput
    .replace(/([?&][a-z0-9_.~-]{1,80}=)[^&\s#"'<>]*/giu, '$1[REDACTED]')
    .replace(/((?:authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|private[_-]?key|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|Bearer\s+[^\s,;]+|[^\s,;]+)/giu, '$1[REDACTED]')
    .replace(/\b(Bearer)\s+[a-z0-9._~+/=-]{8,}/giu, '$1 [REDACTED]')
    .replace(/\b(?:AIza[a-z0-9_-]{20,}|sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{16,}|AKIA[a-z0-9]{16}|xox[baprs]-[a-z0-9-]{16,}|eyJ[a-z0-9_-]{12,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})\b/giu, '[REDACTED]');
  return {
    value: redacted.slice(0, maximum),
    truncated: raw.length > maximum || redacted.length > maximum,
  };
};

export const boundedWorkflowTestFailure = ({
  test,
  error,
  capturedAt = new Date().toISOString(),
}) => {
  assert.doesNotThrow(() => new Date(capturedAt).toISOString(), 'capturedAt must be ISO-compatible');
  const title = boundedFailureText(test?.title ?? 'unknown test', MAX_TEST_FAILURE_TITLE);
  const parent = boundedFailureText(test?.parent ?? '', MAX_TEST_FAILURE_CONTEXT);
  const file = boundedFailureText(test?.file ?? '', MAX_TEST_FAILURE_CONTEXT);
  const uid = boundedFailureText(test?.uid ?? '', MAX_TEST_FAILURE_CONTEXT);
  const hook = boundedFailureText(test?.hook ?? '', 200);
  const name = boundedFailureText(error?.name ?? 'Error', 200);
  const message = boundedFailureText(error?.message ?? error ?? 'WebdriverIO test failed', MAX_TEST_FAILURE_MESSAGE);
  const stack = boundedFailureText(error?.stack ?? '', MAX_TEST_FAILURE_STACK);
  return {
    capturedAt: new Date(capturedAt).toISOString(),
    test: {
      title: title.value,
      parent: parent.value,
      file: file.value,
      uid: uid.value,
      hook: hook.value,
    },
    error: {
      name: name.value,
      message: message.value,
      stack: stack.value,
    },
    truncated: {
      title: title.truncated,
      parent: parent.truncated,
      file: file.truncated,
      uid: uid.truncated,
      hook: hook.truncated,
      name: name.truncated,
      message: message.truncated,
      stack: stack.truncated,
    },
  };
};

const insideDirectory = (root, candidate, label) => {
  const inside = relative(resolve(root), resolve(candidate));
  assert.ok(
    inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`),
    `${label} escaped its evidence root`,
  );
  return candidate;
};

export const workflowEvidenceDirectory = (workflow) => {
  const directory = resolve(WORKFLOW_EVIDENCE_ROOT, safeSegment(workflow, 'workflow'));
  return insideDirectory(WORKFLOW_EVIDENCE_ROOT, directory, 'workflow');
};

const attemptDirectory = (workflow, attemptId) => {
  const root = workflowEvidenceDirectory(workflow);
  const directory = resolve(root, 'attempts', safeSegment(attemptId, 'attempt'));
  return insideDirectory(join(root, 'attempts'), directory, 'attempt');
};

// Windows antivirus can hold a just-named file, surfacing as EPERM (or EBUSY) on open — on
// creation of a recently-seen name and on the read-back reopen of just-written bytes alike. The
// hold scales with content size: scanning a staged media artifact takes seconds, not the
// milliseconds a first bounded retry assumed, and one exhausted 400ms window failed an
// otherwise-green journey. Retry across ~15 seconds total, sleeping without burning a core,
// while keeping a real permission problem fatal with its original error.
const SCAN_RETRY_DELAYS_MS = Object.freeze([50, 100, 200, 400, 800, 1_600, 3_200, 4_000, 4_000]);

const sleepSync = (milliseconds) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  } catch {
    const untilMs = Date.now() + milliseconds;
    while (Date.now() < untilMs) { /* fallback busy-wait */ }
  }
};

const retryOnScan = (operation) => {
  let lastError = null;
  for (const delayMs of [0, ...SCAN_RETRY_DELAYS_MS]) {
    if (delayMs > 0) sleepSync(delayMs);
    try {
      return operation();
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error;
      lastError = error;
    }
  }
  throw lastError;
};

const openRetryingOnScan = (path, flags, mode) => retryOnScan(() => openSync(path, flags, mode));

const copyRetryingOnScan = (source, destination) => {
  retryOnScan(() => copyFileSync(source, destination));
  // Windows CopyFile propagates the source's read-only attribute. The application deliberately
  // publishes its owned artifacts read-only (no-clobber), so a staged copy of one arrived
  // read-only too and the seal's write-mode fsync reopen was denied deterministically — an EPERM
  // no scan-window retry can cure. Staged evidence bytes belong to this store: own them.
  chmodSync(destination, 0o600);
};

const atomicWriteFile = (path, contents) => {
  mkdirSync(dirname(path), { recursive: true });
  recoverAtomicSidecarsForTarget(path);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let descriptor = null;
  try {
    descriptor = openRetryingOnScan(temporary, 'wx', 0o600);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
};

const testCrashPoint = (point) => {
  if (
    process.env.NODE_TEST_CONTEXT !== undefined
    && process.env[TEST_CRASH_POINT_ENVIRONMENT_KEY] === point
  ) {
    process.kill(process.pid, 'SIGKILL');
  }
};

const readJson = (path, fallback = null) => {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
};

const boundedGitState = () => {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  assert.match(commit, /^[0-9a-f]{40,64}$/i, 'workflow evidence requires an exact git commit');
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  }).split(/\r?\n/).filter(Boolean);
  return {
    commit,
    dirty: status.length > 0,
    dirtyEntries: status.slice(0, MAX_DIRTY_ENTRIES),
    dirtyEntriesTruncated: status.length > MAX_DIRTY_ENTRIES,
  };
};

export const collectEvidenceProvenance = ({ binaryPath, requireBinary = true }) => {
  assert.equal(typeof binaryPath, 'string', 'workflow evidence requires the E2E binary path');
  const path = resolve(binaryPath);
  if (!existsSync(path)) {
    assert.equal(requireBinary, false, `workflow evidence binary does not exist: ${path}`);
    return { source: boundedGitState(), binary: { path, exists: false, sha256: null, size: null } };
  }
  const bytes = readFileSync(path);
  return {
    source: boundedGitState(),
    binary: {
      path,
      exists: true,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    },
  };
};

const newAttemptId = () => {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').toLowerCase();
  return `${timestamp}-${process.pid}-${randomBytes(4).toString('hex')}`;
};

const defaultBinaryPath = () => APPLICATION_BINARY;

const initialManifest = ({ attemptId, iteration, journey, provenance, startedAt, workflow }) => ({
  schemaVersion: 2,
  publisher: EVIDENCE_PUBLISHER,
  workflow,
  attempt: {
    id: attemptId,
    journey,
    iteration,
    startedAt,
    endedAt: null,
    outcome: 'running',
    exitStatus: null,
    signal: null,
    failure: null,
  },
  provenance,
  steps: [],
  artifacts: [],
  diagnostics: [],
});

const readAttemptManifest = (workflow, attemptId) => {
  const directory = attemptDirectory(workflow, attemptId);
  if (existsSync(directory)) recoverAttemptOperation({ workflow, attemptId, directory });
  const path = join(directory, 'manifest.json');
  const manifest = readJson(path);
  assert.ok(manifest, `workflow evidence attempt was not initialized: ${path}`);
  return manifest;
};

const samePath = (left, right) => (
  process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
);

const assertOrdinaryPath = (path, kind, label) => {
  const status = lstatSync(path);
  assert.equal(status.isSymbolicLink(), false, `${label} is a link or reparse point`);
  assert.equal(
    kind === 'directory' ? status.isDirectory() : status.isFile(),
    true,
    `${label} is not an ordinary ${kind}`,
  );
  if (kind === 'file') assert.equal(status.nlink, 1, `${label} is a multiply-linked file`);
  assert.equal(samePath(realpathSync.native(path), path), true, `${label} crosses a redirected path`);
  return status;
};

const atomicSidecarsForTarget = (path) => {
  const root = dirname(path);
  if (!existsSync(root)) return [];
  const targetName = basename(path);
  const prefix = `.${targetName}.`;
  const sidecars = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.name.startsWith(prefix))
    .map((entry) => {
      const match = ATOMIC_SIDECAR_PATTERN.exec(entry.name);
      assert.ok(
        match?.[1] === targetName && entry.isFile() && !entry.isSymbolicLink(),
        `atomic evidence target ${targetName} has an unknown sidecar: ${entry.name}`,
      );
      const sidecar = join(root, entry.name);
      assertOrdinaryPath(sidecar, 'file', `atomic evidence sidecar for ${targetName}`);
      return sidecar;
    });
  assert.ok(sidecars.length <= 1, `atomic evidence target ${targetName} has multiple sidecars`);
  return sidecars;
};

const recoverAtomicSidecarsForTarget = (path) => {
  const sidecars = atomicSidecarsForTarget(path);
  if (sidecars.length === 0) return false;
  if (existsSync(path)) rmSync(sidecars[0]);
  else renameSync(sidecars[0], path);
  return true;
};

const manifestHasOwnedIdentity = (manifest, workflow, attemptId) => (
  manifest?.schemaVersion === 2
    && manifest?.publisher === EVIDENCE_PUBLISHER
    && manifest?.workflow === workflow
    && manifest?.attempt?.id === attemptId
);

const recoverAttemptManifestSidecar = ({ workflow, attemptId, directory }) => {
  const path = join(directory, 'manifest.json');
  const [sidecar] = atomicSidecarsForTarget(path);
  if (sidecar === undefined) return false;
  let replacement = null;
  try {
    replacement = JSON.parse(readFileSync(sidecar, 'utf8'));
  } catch {
    // A valid published manifest proves this exact directory is ours, so an incomplete exact
    // sidecar is a recoverable interrupted write rather than foreign evidence.
    if (existsSync(path)) {
      const current = readJson(path);
      assert.ok(manifestHasOwnedIdentity(current, workflow, attemptId),
        `evidence attempt ${attemptId} has an invalid manifest and sidecar`);
      rmSync(sidecar);
      return true;
    }
    throw new Error(`evidence attempt ${attemptId} has only an incomplete manifest sidecar`);
  }
  assert.ok(manifestHasOwnedIdentity(replacement, workflow, attemptId),
    `evidence attempt ${attemptId} has a foreign manifest sidecar`);
  // The destination is the prior durable version; a surviving valid sidecar is necessarily the
  // later complete write because every writer clears older exact sidecars before creating one.
  renameSync(sidecar, path);
  return true;
};

const assertOwnedAttemptManifest = ({ workflow, attemptId, directory }) => {
  assert.match(attemptId, ATTEMPT_ID_PATTERN, 'evidence attempts contain an unknown entry name');
  assertOrdinaryPath(directory, 'directory', `evidence attempt ${attemptId}`);
  const manifestPath = join(directory, 'manifest.json');
  assertOrdinaryPath(manifestPath, 'file', `evidence attempt ${attemptId} manifest`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`evidence attempt ${attemptId} has an unreadable manifest`, { cause: error });
  }
  assert.equal(manifest?.schemaVersion, 2, `evidence attempt ${attemptId} has an unknown schema`);
  assert.equal(
    manifest?.publisher,
    EVIDENCE_PUBLISHER,
    `evidence attempt ${attemptId} is not publisher-owned`,
  );
  assert.equal(manifest?.workflow, workflow, `evidence attempt ${attemptId} changed workflow`);
  assert.equal(manifest?.attempt?.id, attemptId, `evidence attempt ${attemptId} changed identity`);
  assert.ok(
    manifest.attempt.outcome === 'running'
      || manifest.attempt.outcome === 'pass'
      || manifest.attempt.outcome === 'fail',
    `evidence attempt ${attemptId} has an unknown outcome`,
  );
  assert.doesNotThrow(
    () => new Date(manifest.attempt.startedAt).toISOString(),
    `evidence attempt ${attemptId} has an invalid start time`,
  );
  return { directory, manifest };
};

const assertOrdinaryTemporaryTree = (root, label) => {
  const pending = [{ directory: root, depth: 0 }];
  let entries = 0;
  while (pending.length > 0) {
    const { directory, depth } = pending.pop();
    assert.ok(depth <= 16, `${label} exceeds the bounded directory depth`);
    assertOrdinaryPath(directory, 'directory', label);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      assert.ok(entries <= 4_096, `${label} exceeds the bounded entry count`);
      const path = join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `${label} contains a link or reparse point`);
      if (entry.isDirectory()) pending.push({ directory: path, depth: depth + 1 });
      else assertOrdinaryPath(path, 'file', `${label} file`);
    }
  }
};

const validateAttemptPublicationJournal = ({ journal, workflow }) => {
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

const recoverAttemptPublicationTemporaries = (workflow) => {
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

const attemptRecords = (workflow) => {
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

const safeManifestRelativePath = (value, label) => {
  assert.equal(typeof value, 'string', `${label} is not a path`);
  assert.ok(value.length > 0 && value.length <= 260, `${label} is not bounded`);
  assert.equal(isAbsolute(value), false, `${label} is absolute`);
  const parts = value.split(/[\\/]+/u);
  assert.equal(parts.some(part => part === '' || part === '.' || part === '..'), false,
    `${label} contains traversal`);
  return parts.join('/');
};

const ownedAttemptFiles = (manifest) => {
  const files = new Set(['manifest.json', 'README.md']);
  for (const [collection, label] of [
    [manifest.steps, 'screenshot'],
    [manifest.artifacts, 'artifact'],
    [manifest.diagnostics, 'diagnostic'],
  ]) {
    assert.ok(Array.isArray(collection), `evidence ${label} inventory is not an array`);
    for (const record of collection) {
      files.add(safeManifestRelativePath(record?.[label === 'screenshot' ? 'screenshot' : 'file'],
        `evidence ${label}`));
    }
  }
  return files;
};

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const serializedManifest = manifest => `${JSON.stringify(manifest, null, 2)}\n`;
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

const fileIdentity = (path) => {
  const bytes = readFileSync(path);
  return { sha256: sha256(bytes), size: bytes.byteLength };
};

const assertFileIdentity = (path, expected, label) => {
  const actual = fileIdentity(path);
  assert.deepEqual(actual, { sha256: expected.sha256, size: expected.size },
    `${label} changed during evidence publication`);
};

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

const recoverAttemptOperation = ({ workflow, attemptId, directory }) => {
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

const createAttemptOperation = ({ workflow, attemptId, directory }) => {
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

const allocateAttemptOperationPayload = (operation, destination) => {
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

const sealAttemptOperationPayload = (operation, path) => {
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

const stageAttemptOperationContents = (operation, destination, contents) => {
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

const discardUncommittedAttemptOperation = (operation) => {
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

const inspectOwnedAttemptTree = ({ directory, allowedFiles, allowMissing = false }) => {
  const allowedDirectories = new Set();
  for (const file of allowedFiles) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      allowedDirectories.add(parts.slice(0, index).join('/'));
    }
  }
  const pending = [directory];
  const seenFiles = new Set();
  const sidecars = [];
  while (pending.length > 0) {
    const current = pending.pop();
    assertOrdinaryPath(current, 'directory', `owned evidence directory ${current}`);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const relativePath = relative(directory, path).split(sep).join('/');
      assert.ok(
        relativePath !== '' && !relativePath.startsWith('../'),
        'owned evidence traversal escaped its attempt',
      );
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        assert.ok(allowedDirectories.has(relativePath),
          `publisher-owned evidence contains an unknown directory: ${relativePath}`);
        assertOrdinaryPath(path, 'directory', `owned evidence directory ${relativePath}`);
        pending.push(path);
      } else {
        assert.equal(entry.isFile() && !entry.isSymbolicLink(), true,
          `publisher-owned evidence contains a redirected entry: ${relativePath}`);
        assertOrdinaryPath(path, 'file', `owned evidence file ${relativePath}`);
        if (allowedFiles.has(relativePath)) {
          seenFiles.add(relativePath);
          continue;
        }
        const sidecar = ATOMIC_SIDECAR_PATTERN.exec(entry.name);
        const parent = relativePath.includes('/')
          ? relativePath.slice(0, relativePath.lastIndexOf('/') + 1)
          : '';
        const destination = sidecar === null ? null : `${parent}${sidecar[1]}`;
        assert.ok(sidecar && allowedFiles.has(destination),
          `publisher-owned evidence contains an unknown file: ${relativePath}`);
        assert.equal(sidecars.some(candidate => candidate.destinationRelative === destination), false,
          `publisher-owned evidence has multiple atomic sidecars for ${destination}`);
        sidecars.push({
          path,
          destination: join(directory, ...destination.split('/')),
          destinationRelative: destination,
        });
      }
    }
  }
  for (const file of allowedFiles) {
    const recovery = sidecars.some(sidecar => sidecar.destinationRelative === file);
    assert.ok(
      allowMissing || seenFiles.has(file) || recovery,
      `publisher-owned evidence is missing its inventoried file: ${file}`,
    );
  }
  return sidecars;
};

const applyAtomicSidecarRepairs = (repairs) => {
  for (const repair of repairs) {
    if (existsSync(repair.destination)) rmSync(repair.path);
    else renameSync(repair.path, repair.destination);
  }
};

const readLatestSuccessPointer = (workflow) => {
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

const recoverLatestSuccessSidecar = (workflow) => {
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

const latestSuccessfulAttemptId = (workflow, records) => {
  const { attemptId } = readLatestSuccessPointer(workflow);
  if (attemptId === null) return null;
  const record = records.find(({ manifest }) => manifest.attempt.id === attemptId);
  assert.ok(record, `${workflow} latest-success pointer names a missing attempt`);
  assert.equal(record.manifest.attempt.outcome, 'pass',
    `${workflow} latest-success pointer does not name a passing attempt`);
  return attemptId;
};

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

const attemptReadmeContents = (manifest) => {
  const lines = [
    `# ${manifest.workflow} — ${manifest.attempt.id}`,
    '',
    `- Result: **${manifest.attempt.outcome}**`,
    `- Journey: \`${manifest.attempt.journey}\``,
    `- Iteration: ${manifest.attempt.iteration}`,
    `- Started: ${manifest.attempt.startedAt}`,
    `- Ended: ${manifest.attempt.endedAt ?? 'running'}`,
    `- Commit: \`${manifest.provenance.source.commit}\`${manifest.provenance.source.dirty ? ' (dirty)' : ''}`,
    `- Binary: \`${manifest.provenance.binary.path}\``,
    `- Binary SHA-256: \`${manifest.provenance.binary.sha256 ?? 'unavailable'}\``,
    '',
    'PNGs are ordered customer-visible checkpoints from this exact real-binary attempt.',
    '',
  ];
  for (const step of manifest.steps) {
    lines.push(`## ${step.step}`, '', step.description, '', `![${step.step}](${step.screenshot})`, '');
  }
  if (manifest.artifacts.length > 0) {
    lines.push('## Independent artifacts', '');
    for (const artifact of manifest.artifacts) {
      lines.push(`- [${artifact.name}](${artifact.file}) — ${artifact.description}`);
    }
    lines.push('');
  }
  if (manifest.diagnostics.length > 0) {
    lines.push('## Bounded failure diagnostics', '');
    for (const diagnostic of manifest.diagnostics) {
      lines.push(`- [${diagnostic.name}](${diagnostic.file}) — ${diagnostic.description}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};

const refreshWorkflowReadme = (workflow) => {
  const root = workflowEvidenceDirectory(workflow);
  mkdirSync(root, { recursive: true });
  const latest = readJson(join(root, 'latest-success.json'));
  const legacy = readJson(join(root, 'manifest.json'));
  const attempts = attemptRecords(workflow);
  const lines = [
    `# ${workflow}`,
    '',
    latest
      ? `Latest successful evidence: [${latest.attemptId}](${latest.path.replaceAll('\\', '/')}/README.md)`
      : 'Latest successful evidence: **none yet**',
    '',
    'Retention keeps the three newest attempts plus the latest successful proof. A failed attempt '
      + 'never replaces that pointer.',
    '',
  ];
  if (legacy?.schemaVersion === 1) {
    lines.push(
      '## Pre-provenance evidence',
      '',
      'This evidence predates run results and binary hashes, so it is preserved but not promoted as an attested success.',
      '',
    );
    for (const step of legacy.steps ?? []) {
      lines.push(`- [${step.step}](${step.screenshot}) — ${step.description}`);
    }
    lines.push('');
  }
  lines.push('## Attempts', '');
  if (attempts.length === 0) lines.push('- None', '');
  for (const { manifest } of attempts) {
    const { attempt } = manifest;
    lines.push(
      `- [${attempt.id}](attempts/${attempt.id}/README.md) — **${attempt.outcome}**, `
      + `iteration ${attempt.iteration}, ${attempt.startedAt}`,
    );
  }
  atomicWriteFile(join(root, 'README.md'), `${lines.join('\n')}\n`);
};

const refreshRootReadme = () => {
  mkdirSync(WORKFLOW_EVIDENCE_ROOT, { recursive: true });
  const workflows = readdirSync(WORKFLOW_EVIDENCE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(WORKFLOW_EVIDENCE_ROOT, entry.name, 'README.md')))
    .map((entry) => {
      const latest = readJson(join(WORKFLOW_EVIDENCE_ROOT, entry.name, 'latest-success.json'));
      const attempts = attemptRecords(entry.name);
      return {
        name: entry.name,
        latest: latest?.attemptId ?? null,
        attempts: attempts.length,
        failures: attempts.filter(({ manifest }) => manifest.attempt.outcome === 'fail').length,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const lines = [
    '# Real workflow screenshots',
    '',
    'Each workflow contains immutable real-binary attempts and an atomically promoted latest success.',
    '',
    ...workflows.map(({ attempts, failures, latest, name }) => (
      `- [${name}](${name}/README.md) — ${attempts} attempt(s), ${failures} failed, `
      + `latest success ${latest ?? 'none'}`
    )),
    '',
  ];
  atomicWriteFile(join(WORKFLOW_EVIDENCE_ROOT, 'README.md'), lines.join('\n'));
};

/**
 * Rebuild the generated top-level browser from whatever attempts and latest-success pointers are
 * actually on disk right now. `beginWorkflowEvidence` and `finalizeWorkflowEvidence` already call
 * this after every attempt, but that update is not atomic with the manifest write it follows: a
 * process killed between the two (or by an external retention/cleanup operation) can leave a
 * truthful manifest behind a stale index for a workflow that never runs again this session. The
 * isolated runner calls this once before and once after every suite invocation so the index is
 * never more than one crashed attempt away from the truth, and never depends on that workflow
 * being retried to self-heal.
 */
export const refreshWorkflowEvidenceIndex = () => refreshRootReadme();

const writeManifest = (manifest, { operation = null } = {}) => {
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

export const beginWorkflowEvidence = ({
  workflow,
  journey,
  iteration,
  binaryPath = defaultBinaryPath(),
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
  const manifest = initialManifest({
    attemptId,
    iteration,
    journey,
    provenance: provenance ?? collectEvidenceProvenance({ binaryPath, requireBinary }),
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
      dirty: manifest.provenance.source.dirty,
      binarySha256: manifest.provenance.binary.sha256,
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
export const resetWorkflowEvidence = (workflow) => {
  const attempt = beginWorkflowEvidence({
    workflow,
    journey: 'legacy-multi-process-scenario',
    iteration: 1,
    requireBinary: false,
  });
  process.env[ATTEMPT_ENVIRONMENT_KEY] = attempt.id;
  return attempt.directory;
};

const activeAttempt = (workflow) => {
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

const readActiveManifest = (workflow) => {
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

export const collectVisibleStateFromPage = () => {
  const boundedHorizontalScroll = (value) => {
    const offset = Number(value);
    if (!Number.isFinite(offset)) return null;
    return Math.max(-1_000_000, Math.min(1_000_000, offset));
  };
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const textOf = (node) => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
  const uniqueText = (nodes) => [...new Set(nodes.filter(visible).map(textOf).filter(Boolean))];
  const errorToasts = uniqueText([
    ...document.querySelectorAll('.toast-item.live .toast.toast-error'),
  ]).slice(-8);
  const errorAlerts = uniqueText([
    ...document.querySelectorAll('.error, [role="alert"]'),
  ].filter((node) => node.closest('.toast-item') === null)).slice(0, 12);
  const overflowPx = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
  return {
    viewport: [window.innerWidth, window.innerHeight],
    document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    horizontalOverflow: overflowPx > 0,
    horizontalOverflowPx: overflowPx,
    // Root scroll position is independent from scrollWidth: a viewport-width document can still be
    // displaced. Deliberately do not inspect nested scrollers; timelines and tab strips may rest at
    // a nonzero local offset without moving the customer-visible document.
    horizontalScroll: {
      window: boundedHorizontalScroll(window.scrollX ?? window.pageXOffset ?? 0),
      document: boundedHorizontalScroll(document.documentElement.scrollLeft),
      body: boundedHorizontalScroll(document.body?.scrollLeft ?? 0),
    },
    previewState: document.querySelector('[data-osg-preview]')?.getAttribute('data-osg-preview') ?? null,
    renderAdmission: document.querySelector('[data-osg-render-admission]')
      ?.getAttribute('data-osg-render-admission') ?? null,
    alerts: [...errorAlerts, ...errorToasts],
    errorAlerts,
    errorToasts,
    toasts: [...document.querySelectorAll('.toast-item.live .toast')]
      .filter(visible).map(textOf).filter(Boolean).slice(-8),
    visibleText: textOf(document.body).slice(0, 4_000),
  };
};

const visibleState = () => browser.execute(collectVisibleStateFromPage);

const unavailableVisibleState = (error) => ({
  viewport: null,
  document: null,
  horizontalOverflow: false,
  horizontalOverflowPx: 0,
  horizontalScroll: { window: null, document: null, body: null },
  previewState: null,
  renderAdmission: null,
  alerts: [],
  errorAlerts: [],
  errorToasts: [],
  toasts: [],
  visibleText: '',
  captureUnavailable: String(error?.message ?? error).slice(0, 500),
});

const bestEffortVisibleState = async () => {
  try {
    return await visibleState();
  } catch (error) {
    return unavailableVisibleState(error);
  }
};

const validateTextAllowances = (entries, label) => {
  if (entries === undefined) return [];
  assert.ok(Array.isArray(entries) && entries.length <= 4, `${label} allowance must contain at most four entries`);
  return entries.map((entry) => {
    assert.deepEqual(Object.keys(entry).sort(), ['reason', 'text'], `${label} allowance must name exact text and reason`);
    assert.equal(typeof entry.text, 'string');
    assert.ok(entry.text.length > 0 && entry.text.length <= 500, `${label} allowance text must be bounded`);
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.trim().length >= 8 && entry.reason.length <= 300, `${label} allowance needs a bounded reason`);
    return entry.text;
  });
};

/**
 * Reject customer-visible failures by default. A journey may allow only an exact error string, or
 * a measured overflow of at most 16 px, and must document why that state is the subject under test.
 * Broad booleans, regexes and substring matches are intentionally unsupported.
 */
export const validateVisibleState = (state, allowVisibleProblems = {}) => {
  assert.deepEqual(
    Object.keys(allowVisibleProblems).sort(),
    Object.keys(allowVisibleProblems).filter((key) => (
      key === 'errorAlerts' || key === 'errorToasts' || key === 'horizontalOverflow'
    )).sort(),
    'unknown visible-problem allowance',
  );
  const allowedAlerts = validateTextAllowances(allowVisibleProblems.errorAlerts, 'errorAlerts');
  const allowedToasts = validateTextAllowances(allowVisibleProblems.errorToasts, 'errorToasts');
  const unexpectedAlerts = (state.errorAlerts ?? state.alerts ?? [])
    .filter((text) => !allowedAlerts.includes(text));
  const unexpectedToasts = (state.errorToasts ?? [])
    .filter((text) => !allowedToasts.includes(text));
  assert.deepEqual(unexpectedAlerts, [], `workflow screenshot contains visible error alert(s): ${unexpectedAlerts.join(' | ')}`);
  assert.deepEqual(unexpectedToasts, [], `workflow screenshot contains visible error toast(s): ${unexpectedToasts.join(' | ')}`);

  const horizontalScroll = state.horizontalScroll;
  assert.ok(
    horizontalScroll !== null && typeof horizontalScroll === 'object' && !Array.isArray(horizontalScroll),
    'workflow visible state must record bounded window/document/body horizontal scroll offsets',
  );
  assert.deepEqual(
    Object.keys(horizontalScroll).sort(),
    ['body', 'document', 'window'],
    'workflow visible state must record only window/document/body horizontal scroll offsets',
  );
  for (const [root, offset] of Object.entries(horizontalScroll)) {
    assert.ok(
      Number.isFinite(offset) && Math.abs(offset) <= MAX_CAPTURED_HORIZONTAL_SCROLL_PX,
      `workflow visible state has an invalid ${root} horizontal scroll offset`,
    );
  }
  const displacedRoots = Object.entries(horizontalScroll)
    .filter(([, offset]) => offset !== 0)
    .map(([root, offset]) => `${root}=${offset}px`);
  assert.deepEqual(
    displacedRoots,
    [],
    `workflow screenshot rests at nonzero horizontal document scroll: ${displacedRoots.join(', ')}`,
  );

  const overflowPx = state.horizontalOverflowPx ?? (state.horizontalOverflow ? 1 : 0);
  if (overflowPx > 0) {
    const allowance = allowVisibleProblems.horizontalOverflow;
    assert.ok(allowance && typeof allowance === 'object', `workflow screenshot overflows horizontally by ${overflowPx}px`);
    assert.deepEqual(
      Object.keys(allowance).sort(),
      ['maxPixels', 'reason'],
      'horizontal overflow allowance must name maxPixels and reason',
    );
    assert.ok(Number.isSafeInteger(allowance.maxPixels) && allowance.maxPixels >= 1 && allowance.maxPixels <= 16,
      'horizontal overflow allowance must be 1..16px');
    assert.equal(typeof allowance.reason, 'string');
    assert.ok(allowance.reason.trim().length >= 8 && allowance.reason.length <= 300,
      'horizontal overflow allowance needs a bounded reason');
    assert.ok(overflowPx <= allowance.maxPixels,
      `workflow screenshot overflows by ${overflowPx}px, above allowed ${allowance.maxPixels}px`);
  }
  return state;
};

const boundedBrowserDiagnostics = async (state) => {
  const diagnostic = { capturedAt: new Date().toISOString(), visibleState: state };
  for (const [name, method] of [
    ['url', 'getUrl'],
    ['title', 'getTitle'],
    ['windowRect', 'getWindowRect'],
  ]) {
    try {
      const value = await browser[method]();
      diagnostic[name] = typeof value === 'string' ? value.slice(0, 2_000) : value;
    } catch (error) {
      diagnostic[`${name}Unavailable`] = String(error?.message ?? error).slice(0, 500);
    }
  }
  // The embedded Tauri provider does not implement WebDriver's `se/log` endpoint. Calling it makes
  // the transport retry and print four warnings while adding no diagnostic evidence; app JSONL and
  // the bounded DOM snapshot are the supported authorities in this channel.
  if (process.env.OSG_E2E_OFFSCREEN_WINDOW === '1') {
    diagnostic.browserLogsUnavailable = 'embedded Tauri WebDriver does not implement se/log';
  } else {
    try {
      const logs = await browser.getLogs('browser');
      diagnostic.browserLogs = logs.slice(-MAX_BROWSER_LOGS).map((entry) => ({
        level: String(entry.level ?? '').slice(0, 32),
        source: String(entry.source ?? '').slice(0, 100),
        timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : null,
        message: String(entry.message ?? '').slice(0, MAX_BROWSER_LOG_MESSAGE),
      }));
    } catch (error) {
      diagnostic.browserLogsUnavailable = String(error?.message ?? error).slice(0, 500);
    }
  }
  return diagnostic;
};

const appLogTails = () => {
  const runRoot = process.env.OSG_E2E_DATA_ROOT;
  if (!runRoot) return [];
  const logsRoot = join(runRoot, 'logs');
  if (!existsSync(logsRoot)) return [];
  const files = [];
  const visit = (directory, depth) => {
    if (depth > 2 || files.length >= MAX_APP_LOG_FILES) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      files.push({ path: directory, discoveryError: String(error?.message ?? error).slice(0, 500) });
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_APP_LOG_FILES) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile()) files.push({ path, discoveryError: null });
    }
  };
  visit(logsRoot, 0);
  return files.map(({ discoveryError, path }) => {
    const file = relative(logsRoot, path).replaceAll('\\', '/');
    if (discoveryError !== null) return { file, unavailable: discoveryError };
    try {
      const bytes = readFileSync(path);
      const tail = bytes.subarray(Math.max(0, bytes.byteLength - MAX_APP_LOG_TAIL_BYTES));
      return {
        file,
        size: bytes.byteLength,
        tail: tail.toString('utf8'),
        tailTruncated: bytes.byteLength > MAX_APP_LOG_TAIL_BYTES,
      };
    } catch (error) {
      return { file, unavailable: String(error?.message ?? error).slice(0, 500) };
    }
  });
};

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
