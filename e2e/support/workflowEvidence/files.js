// Filesystem primitives for evidence: antivirus-tolerant I/O, atomic writes and sidecar recovery,
// ordinary-path checks, content identity, and test crash points.

import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const ATOMIC_SIDECAR_PATTERN = /^\.(.+)\.\d{1,10}\.([0-9a-f]{12})\.tmp$/u;
const TEST_CRASH_POINT_ENVIRONMENT_KEY = 'OSG_E2E_TEST_EVIDENCE_CRASH_POINT';
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

export const openRetryingOnScan = (path, flags, mode) => retryOnScan(() => openSync(path, flags, mode));

export const copyRetryingOnScan = (source, destination) => {
  retryOnScan(() => copyFileSync(source, destination));
  // Windows CopyFile propagates the source's read-only attribute. The application deliberately
  // publishes its owned artifacts read-only (no-clobber), so a staged copy of one arrived
  // read-only too and the seal's write-mode fsync reopen was denied deterministically — an EPERM
  // no scan-window retry can cure. Staged evidence bytes belong to this store: own them.
  chmodSync(destination, 0o600);
};

export const atomicWriteFile = (path, contents) => {
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

export const testCrashPoint = (point) => {
  if (
    process.env.NODE_TEST_CONTEXT !== undefined
    && process.env[TEST_CRASH_POINT_ENVIRONMENT_KEY] === point
  ) {
    process.kill(process.pid, 'SIGKILL');
  }
};

export const readJson = (path, fallback = null) => {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
};

export const samePath = (left, right) => (
  process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
);

export const assertOrdinaryPath = (path, kind, label) => {
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

export const atomicSidecarsForTarget = (path) => {
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

export const recoverAtomicSidecarsForTarget = (path) => {
  const sidecars = atomicSidecarsForTarget(path);
  if (sidecars.length === 0) return false;
  if (existsSync(path)) rmSync(sidecars[0]);
  else renameSync(sidecars[0], path);
  return true;
};

export const assertOrdinaryTemporaryTree = (root, label) => {
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

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const fileIdentity = (path) => {
  const bytes = readFileSync(path);
  return { sha256: sha256(bytes), size: bytes.byteLength };
};

export const assertFileIdentity = (path, expected, label) => {
  const actual = fileIdentity(path);
  assert.deepEqual(actual, { sha256: expected.sha256, size: expected.size },
    `${label} changed during evidence publication`);
};

export const inspectOwnedAttemptTree = ({ directory, allowedFiles, allowMissing = false }) => {
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

export const applyAtomicSidecarRepairs = (repairs) => {
  for (const repair of repairs) {
    if (existsSync(repair.destination)) rmSync(repair.path);
    else renameSync(repair.path, repair.destination);
  }
};
