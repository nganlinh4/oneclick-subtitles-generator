import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, realpathSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import {
  basename, dirname, isAbsolute, join, relative, resolve, sep,
} from 'node:path';
import process from 'node:process';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_RECEIPT_BYTES = 64 * 1024;
const RECEIPT_KEYS = 'file|fixture|payload|probe|schemaVersion';
const PAYLOAD_KEYS = 'sha256|sizeBytes';
const FIXTURE_KEYS = 'kind|recipeSha256|source|tools';

const samePath = (left, right) => (
  process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
);

const exactKeys = (value, keys) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys;

export const sha256File = (path) => {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, 'r');
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest('hex');
};

const sha256Json = (value) => createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex');

export const assertOrdinaryFixtureFile = (path, { label, parent = dirname(path) }) => {
  const remainder = relative(resolve(parent), resolve(path));
  if (
    remainder === ''
    || remainder === '..'
    || remainder.startsWith(`..${sep}`)
    || isAbsolute(remainder)
    || remainder.includes(sep)
  ) {
    throw new Error(`${label} must be one direct child of its managed cache`);
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} is not one ordinary singly-linked file`);
  }
  if (!samePath(realpathSync.native(path), path)) {
    throw new Error(`${label} crosses a redirected path`);
  }
  return metadata;
};

const portableRelative = (root, path) => relative(resolve(root), resolve(path)).replaceAll('\\', '/');

/**
 * Freeze the exact reviewed executables which produced a fixture. The resolver has already
 * authenticated the complete native-tools delivery; this second, compact proof makes cache reuse
 * sensitive to a delivery/version change without trusting an ambient executable or PATH.
 */
export const reviewedToolProvenance = ({ storeRoot, roles }) => Object.freeze(
  Object.fromEntries(Object.entries(roles).sort(([left], [right]) => left.localeCompare(right)).map(
    ([role, path]) => {
      const relativePath = portableRelative(storeRoot, path);
      if (relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
        throw new Error(`reviewed ${role} escaped the native-tools store`);
      }
      const metadata = assertOrdinaryFixtureFile(path, { label: `reviewed ${role}` });
      return [role, Object.freeze({
        relativePath,
        sizeBytes: metadata.size,
        sha256: sha256File(path),
      })];
    },
  )),
);

export const managedFixtureIdentity = ({ kind, recipe, source = null, tools }) => {
  if (!/^[a-z][a-z0-9-]{2,63}$/u.test(kind)) throw new Error('managed fixture kind is invalid');
  if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe)) {
    throw new Error('managed fixture recipe is invalid');
  }
  if (tools === null || typeof tools !== 'object' || Array.isArray(tools)) {
    throw new Error('managed fixture tool provenance is invalid');
  }
  return Object.freeze({
    kind,
    recipeSha256: sha256Json(recipe),
    source,
    tools,
  });
};

const readReceipt = (receiptPath, cacheRoot) => {
  const metadata = assertOrdinaryFixtureFile(receiptPath, {
    label: 'managed fixture receipt', parent: cacheRoot,
  });
  if (metadata.size < 2 || metadata.size > MAX_RECEIPT_BYTES) {
    throw new Error('managed fixture receipt exceeds its bounded schema size');
  }
  return JSON.parse(readFileSync(receiptPath, 'utf8'));
};

const receiptShapeIsValid = ({ receipt, expectedFixture, originalName, validateProbe }) => {
  if (
    !exactKeys(receipt, RECEIPT_KEYS)
    || receipt.schemaVersion !== 1
    || !exactKeys(receipt.fixture, FIXTURE_KEYS)
    || JSON.stringify(receipt.fixture) !== JSON.stringify(expectedFixture)
    || !exactKeys(receipt.payload, PAYLOAD_KEYS)
    || !Number.isSafeInteger(receipt.payload.sizeBytes)
    || receipt.payload.sizeBytes <= 0
    || !SHA256.test(receipt.payload.sha256 ?? '')
    || receipt.file !== `${receipt.payload.sha256}-${originalName}`
  ) return false;
  try {
    const normalized = validateProbe(receipt.probe);
    return JSON.stringify(normalized) === JSON.stringify(receipt.probe)
      && receipt.probe.sizeBytes === receipt.payload.sizeBytes;
  } catch {
    return false;
  }
};

export const cachedManagedFixture = ({
  cacheRoot, expectedFixture, originalName, validateProbe, receiptName = 'receipt.json',
}) => {
  const receiptPath = join(cacheRoot, receiptName);
  if (!existsSync(receiptPath)) return null;
  try {
    const receipt = readReceipt(receiptPath, cacheRoot);
    if (!receiptShapeIsValid({ receipt, expectedFixture, originalName, validateProbe })) return null;
    const payloadPath = join(cacheRoot, receipt.file);
    const metadata = assertOrdinaryFixtureFile(payloadPath, {
      label: 'managed fixture payload', parent: cacheRoot,
    });
    if (
      metadata.size !== receipt.payload.sizeBytes
      || sha256File(payloadPath) !== receipt.payload.sha256
    ) return null;
    return Object.freeze({ path: payloadPath, receipt });
  } catch {
    return null;
  }
};

const atomicWriteReceipt = ({ assertStillLive, receiptPath, receipt }) => {
  const temporary = join(
    dirname(receiptPath),
    `.${basename(receiptPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp.json`,
  );
  let descriptor = null;
  try {
    assertStillLive();
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    assertStillLive();
    renameSync(temporary, receiptPath);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      assertStillLive();
      rmSync(temporary, { force: true });
    } catch {
      // A reclaimed owner has no authority to clean persistent state; the next live owner does.
    }
  }
};

const removeWhileLive = ({ assertStillLive, path }) => {
  assertStillLive();
  rmSync(path, { force: true });
};

/**
 * Publish payload first under its full digest, then atomically swing receipt.json to it. The prior
 * generation remains selected until the receipt commit. A stale owner never attempts rollback.
 */
export const publishManagedFixture = ({
  assertStillLive,
  cacheRoot,
  candidate,
  expectedFixture,
  originalName,
  probe,
  validateProbe,
  receiptName = 'receipt.json',
  afterPayload = () => {},
}) => {
  const normalizedProbe = validateProbe(probe);
  if (JSON.stringify(normalizedProbe) !== JSON.stringify(probe)) {
    throw new Error('managed fixture probe is not in its canonical form');
  }
  const candidateMetadata = assertOrdinaryFixtureFile(candidate, {
    label: 'managed fixture candidate', parent: cacheRoot,
  });
  const payload = Object.freeze({
    sizeBytes: candidateMetadata.size,
    sha256: sha256File(candidate),
  });
  if (probe.sizeBytes !== payload.sizeBytes) {
    throw new Error('managed fixture probe size does not match its payload');
  }
  const file = `${payload.sha256}-${originalName}`;
  const destination = join(cacheRoot, file);
  const receiptPath = join(cacheRoot, receiptName);
  const prior = cachedManagedFixture({
    cacheRoot, expectedFixture, originalName, validateProbe, receiptName,
  });
  const destinationExisted = existsSync(destination);
  if (destinationExisted) {
    const metadata = assertOrdinaryFixtureFile(destination, {
      label: 'existing managed fixture payload', parent: cacheRoot,
    });
    if (metadata.size !== payload.sizeBytes || sha256File(destination) !== payload.sha256) {
      throw new Error('content-addressed fixture destination contains different bytes');
    }
    removeWhileLive({ assertStillLive, path: candidate });
  } else {
    const descriptor = openSync(candidate, 'r+');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    assertStillLive();
    renameSync(candidate, destination);
  }
  const receipt = Object.freeze({
    schemaVersion: 1,
    fixture: expectedFixture,
    file,
    payload,
    probe,
  });
  try {
    afterPayload(destination);
    atomicWriteReceipt({ assertStillLive, receiptPath, receipt });
    const selected = cachedManagedFixture({
      cacheRoot, expectedFixture, originalName, validateProbe, receiptName,
    });
    if (selected?.path !== destination) {
      throw new Error('managed fixture publication failed exact receipt read-back');
    }
  } catch (error) {
    // receipt.json still selects the prior valid generation unless atomic rename completed. If the
    // authority is stale, leave any unreferenced content-addressed orphan for a future live owner.
    assertStillLive();
    if (prior !== null) {
      atomicWriteReceipt({ assertStillLive, receiptPath, receipt: prior.receipt });
    } else {
      rmSync(receiptPath, { force: true });
    }
    if (!destinationExisted && prior?.path !== destination) rmSync(destination, { force: true });
    throw error;
  }
  if (prior !== null && prior.path !== destination) {
    removeWhileLive({ assertStillLive, path: prior.path });
  }
  return destination;
};

/** Remove only unreferenced files owned by this fixture naming scheme, under current authority. */
export const pruneManagedFixtureOrphans = ({
  assertStillLive, cacheRoot, originalName, selectedPath = null, receiptName = 'receipt.json',
}) => {
  const payloadPattern = new RegExp(`^[0-9a-f]{64}-${originalName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u');
  const temporaryPattern = /^\..+\.tmp(?:\.mp4|\.json)?$/u;
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    const path = join(cacheRoot, entry.name);
    if (
      entry.name !== receiptName
      && path !== selectedPath
      && (payloadPattern.test(entry.name) || temporaryPattern.test(entry.name))
    ) {
      assertStillLive();
      rmSync(path, { force: true });
    }
  }
};
