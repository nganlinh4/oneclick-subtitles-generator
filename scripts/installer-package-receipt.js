#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { readCleanGitSourceProvenance } = require('./git-source-provenance.js');

const HASH = /^[0-9a-f]{64}$/u;
const GIT_OBJECT = /^[0-9a-f]{40,64}$/u;
const PUBLISHER = 'osg-installer-package-receipt';
const SCHEMA_VERSION = 2;
const EXECUTABLE_NAME = 'osg-desktop.exe';
const UNINSTALLER_NAME = 'uninstall.exe';
const DEFAULT_PUBLIC_KEY_PATH = path.resolve(
  __dirname, '..', 'apps', 'desktop', 'src-tauri', 'updater-public-key.txt',
);
const DEFAULT_REPOSITORY_ROOT = path.resolve(__dirname, '..');

const sha256Bytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const canonicalFilesystemPath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === 'win32'
    ? resolved.replace(/^\\\\\?\\/u, '').toLowerCase()
    : resolved;
};

const assertRealPathIdentity = (file, label) => {
  const real = fs.realpathSync.native(file);
  if (canonicalFilesystemPath(real) !== canonicalFilesystemPath(file)) {
    throw new Error(`${label} must not cross a reparse point or redirected ancestor`);
  }
};

const assertIndependentRegularFile = (file, label) => {
  const status = fs.lstatSync(file);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error(`${label} must be one independent regular file`);
  }
  assertRealPathIdentity(file, label);
  return status;
};

const sha256 = (file, label = 'hashed input') => {
  assertIndependentRegularFile(file, label);
  return sha256Bytes(fs.readFileSync(file));
};

const portablePathCompare = (left, right) => Buffer.compare(
  Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'),
);

const isCanonicalPortablePath = (value) => (
  typeof value === 'string'
  && value.length > 0
  && value !== '.'
  && !value.includes('\\')
  && !value.includes('\0')
  && !value.startsWith('/')
  && !value.endsWith('/')
  && path.posix.normalize(value) === value
  && value.split('/').every((component) => component !== '' && component !== '.' && component !== '..')
);

const readPayloadContract = (repositoryRoot = DEFAULT_REPOSITORY_ROOT) => {
  const configPath = path.join(repositoryRoot, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
  assertIndependentRegularFile(configPath, 'Tauri package configuration');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const resources = config.bundle?.resources;
  if (!resources || Array.isArray(resources) || typeof resources !== 'object') {
    throw new Error('Tauri package configuration has no resource mapping');
  }
  const byPath = new Map([
    [EXECUTABLE_NAME, Object.freeze({ path: EXECUTABLE_NAME, type: 'file' })],
    [UNINSTALLER_NAME, Object.freeze({ path: UNINSTALLER_NAME, type: 'file' })],
  ]);
  for (const [source, destination] of Object.entries(resources)) {
    if (!isCanonicalPortablePath(destination)) {
      throw new Error(`Tauri package resource has an unsafe destination: ${destination}`);
    }
    if (byPath.has(destination)) {
      throw new Error(`Tauri package resources alias destination ${destination}`);
    }
    const sourcePath = path.resolve(path.dirname(configPath), source);
    assertIndependentRegularFile(sourcePath, `Tauri package resource ${destination}`);
    byPath.set(destination, Object.freeze({ path: destination, type: 'file', sourcePath }));
    const components = destination.split('/');
    for (let count = 1; count < components.length; count += 1) {
      const directory = components.slice(0, count).join('/');
      const existing = byPath.get(directory);
      if (existing?.type === 'file') {
        throw new Error(`Tauri package resource traverses file destination ${directory}`);
      }
      byPath.set(directory, Object.freeze({ path: directory, type: 'directory' }));
    }
  }
  return [...byPath.values()].sort((left, right) => portablePathCompare(left.path, right.path));
};

const assertPayloadContract = (entries, contract) => {
  if (!Array.isArray(contract) || contract.length === 0 || entries.length !== contract.length) {
    throw new Error('installed payload does not match the authoritative package resource set');
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const expected = contract[index];
    if (entry.path !== expected.path || entry.type !== expected.type) {
      throw new Error('installed payload does not match the authoritative package resource set');
    }
    if (expected.sourcePath !== undefined
        && (entry.type !== 'file' || entry.sha256 !== sha256(expected.sourcePath, `source for ${entry.path}`))) {
      throw new Error(`installed payload resource differs from its reviewed source: ${entry.path}`);
    }
  }
};

const payloadInventory = (executablePath, payloadContract = null) => {
  const executable = path.resolve(executablePath);
  if (path.basename(executable).toLowerCase() !== EXECUTABLE_NAME) {
    throw new Error(`installed payload executable must be named ${EXECUTABLE_NAME}`);
  }
  const root = path.dirname(executable);
  const rootStatus = fs.lstatSync(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error('installed payload root must be one real directory');
  }
  assertRealPathIdentity(root, 'installed payload root');

  const entries = [];
  const visit = (directory, prefix) => {
    const directoryStatus = fs.lstatSync(directory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
      throw new Error('installed payload contains a redirected directory');
    }
    assertRealPathIdentity(directory, 'installed payload directory');
    for (const name of fs.readdirSync(directory)) {
      if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
        throw new Error('installed payload contains an invalid filesystem entry name');
      }
      const absolute = path.join(directory, name);
      const portable = prefix === '' ? name : `${prefix}/${name}`;
      const status = fs.lstatSync(absolute);
      if (status.isSymbolicLink()) {
        throw new Error(`installed payload entry is redirected: ${portable}`);
      }
      assertRealPathIdentity(absolute, `installed payload entry ${portable}`);
      if (status.isDirectory()) {
        entries.push({ path: portable, type: 'directory' });
        visit(absolute, portable);
      } else if (status.isFile()) {
        if (status.nlink !== 1) {
          throw new Error(`installed payload entry is hard-linked: ${portable}`);
        }
        entries.push({
          path: portable,
          type: 'file',
          size: status.size,
          sha256: sha256Bytes(fs.readFileSync(absolute)),
        });
      } else {
        throw new Error(`installed payload entry has an unsupported type: ${portable}`);
      }
    }
  };
  visit(root, '');
  entries.sort((left, right) => portablePathCompare(left.path, right.path));

  const executableEntry = entries.find(({ path: portable }) => portable === EXECUTABLE_NAME);
  const uninstallerEntry = entries.find(({ path: portable }) => portable === UNINSTALLER_NAME);
  if (executableEntry?.type !== 'file' || uninstallerEntry?.type !== 'file') {
    throw new Error('installed payload must contain the application executable and generated uninstaller');
  }
  if (payloadContract !== null) assertPayloadContract(entries, payloadContract);
  return entries;
};

const applicationHashForPayload = (payloadEntries) => crypto.createHash('sha256')
  .update(`${JSON.stringify({ payloadEntries })}\n`)
  .digest('hex');

const packageReceiptBytes = ({
  source, applicationHash, payloadEntries, payloadExecutableSha256, installerSha256,
}) => Buffer.from(`${JSON.stringify({
  schemaVersion: SCHEMA_VERSION,
  publisher: PUBLISHER,
  source,
  applicationHash,
  payloadEntries,
  payloadExecutableSha256,
  installerSha256,
}, null, 2)}\n`);

const decodeCanonicalBase64 = (value, label) => {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error(`${label} is not canonical base64`);
  return decoded;
};

const decodeUtf8 = (bytes, label) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
};

const readUpdaterMinisignPublicKey = (publicKeyPath = DEFAULT_PUBLIC_KEY_PATH) => {
  assertIndependentRegularFile(publicKeyPath, 'updater Minisign public key');
  const encoded = fs.readFileSync(publicKeyPath, 'utf8').trim();
  const decoded = decodeUtf8(
    decodeCanonicalBase64(encoded, 'encoded updater public key'), 'updater public key',
  );
  const lines = decoded.replace(/\r\n/gu, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment: ')) {
    throw new Error('updater public key does not use the Minisign public-key envelope');
  }
  const binary = decodeCanonicalBase64(lines[1], 'Minisign public key');
  if (binary.length !== 42
      || binary[0] !== 0x45
      || (binary[1] !== 0x64 && binary[1] !== 0x44)) {
    throw new Error('updater public key has an unsupported Minisign algorithm');
  }
  const keyId = binary.subarray(2, 10);
  const rawKey = binary.subarray(10);
  const subjectPublicKeyInfo = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), rawKey,
  ]);
  return Object.freeze({
    keyId,
    publicKey: crypto.createPublicKey({
      key: subjectPublicKeyInfo, format: 'der', type: 'spki',
    }),
  });
};

const verifyMinisign = ({ bytes, signaturePath, publicKeyPath = DEFAULT_PUBLIC_KEY_PATH }) => {
  assertIndependentRegularFile(signaturePath, 'installer package receipt signature');
  const signatureBytes = fs.readFileSync(signaturePath);
  const signatureOuterText = decodeUtf8(
    signatureBytes, 'installer package receipt signature',
  );
  const signatureOuter = signatureOuterText.endsWith('\n')
    ? signatureOuterText.slice(0, -1)
    : signatureOuterText;
  if (signatureOuter.includes('\r') || signatureOuter.includes('\n')) {
    throw new Error('installer package receipt signature outer envelope must be one canonical line');
  }
  const envelope = decodeUtf8(
    decodeCanonicalBase64(signatureOuter, 'encoded installer package receipt signature'),
    'installer package receipt Minisign envelope',
  );
  if (envelope.includes('\r')) {
    throw new Error('installer package receipt Minisign envelope must use canonical LF line endings');
  }
  const lines = envelope.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== 4
      || !lines[0].startsWith('untrusted comment: ')
      || !lines[2].startsWith('trusted comment: ')) {
    throw new Error('installer package receipt signature has an invalid Minisign envelope');
  }
  const primary = decodeCanonicalBase64(lines[1], 'Minisign primary signature');
  const global = decodeCanonicalBase64(lines[3], 'Minisign global signature');
  if (primary.length !== 74 || global.length !== 64
      || primary[0] !== 0x45 || primary[1] !== 0x44) {
    throw new Error('installer package receipt signature must use prehashed Minisign Ed25519');
  }
  const trusted = readUpdaterMinisignPublicKey(publicKeyPath);
  if (!crypto.timingSafeEqual(primary.subarray(2, 10), trusted.keyId)) {
    throw new Error('installer package receipt was signed by a foreign key');
  }
  const signature = primary.subarray(10);
  const prehash = crypto.createHash('blake2b512').update(bytes).digest();
  if (!crypto.verify(null, prehash, trusted.publicKey, signature)) {
    throw new Error('installer package receipt signature is invalid');
  }
  const trustedComment = Buffer.from(lines[2].slice('trusted comment: '.length), 'utf8');
  if (!crypto.verify(
    null, Buffer.concat([signature, trustedComment]), trusted.publicKey, global,
  )) {
    throw new Error('installer package receipt trusted comment signature is invalid');
  }
  return sha256Bytes(signatureBytes);
};

const signWithTauriUpdaterKey = ({ receiptPath, repositoryRoot }) => {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH is required');
  }
  const cli = path.resolve(
    repositoryRoot, 'apps', 'desktop', 'node_modules', '@tauri-apps', 'cli', 'tauri.js',
  );
  assertIndependentRegularFile(cli, 'locked Tauri signer CLI');
  const result = spawnSync(process.execPath, [cli, 'signer', 'sign', receiptPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Tauri signer failed with ${result.status}: ${result.stderr || result.stdout}`);
  }
};

const publishInstallerPackageReceipt = ({
  installerPath,
  installedExecutablePath,
  repositoryRoot,
  outputPath,
  publicKeyPath = path.resolve(
    repositoryRoot, 'apps', 'desktop', 'src-tauri', 'updater-public-key.txt',
  ),
  signReceipt = signWithTauriUpdaterKey,
  payloadContract = readPayloadContract(repositoryRoot),
}) => {
  const signaturePath = `${outputPath}.sig`;
  if (fs.existsSync(outputPath) || fs.existsSync(signaturePath)) {
    throw new Error('installer package receipt and signature paths must be clean');
  }
  const installerSha256 = sha256(installerPath, 'installer');
  const payloadEntries = payloadInventory(installedExecutablePath, payloadContract);
  const payloadExecutableSha256 = payloadEntries.find(({ path: portable }) => (
    portable === EXECUTABLE_NAME
  )).sha256;
  const receipt = {
    source: readCleanGitSourceProvenance({ repositoryRoot }),
    applicationHash: applicationHashForPayload(payloadEntries),
    payloadEntries,
    payloadExecutableSha256,
    installerSha256,
  };
  const bytes = packageReceiptBytes(receipt);
  fs.writeFileSync(outputPath, bytes, { flag: 'wx', mode: 0o600 });
  try {
    signReceipt({ receiptPath: outputPath, repositoryRoot });
    const receiptSignatureSha256 = verifyMinisign({ bytes, signaturePath, publicKeyPath });
    return Object.freeze({
      ...receipt,
      receiptPath: path.resolve(outputPath),
      signaturePath: path.resolve(signaturePath),
      receiptSha256: sha256Bytes(bytes),
      receiptSignatureSha256,
    });
  } catch (error) {
    fs.rmSync(signaturePath, { force: true });
    fs.rmSync(outputPath, { force: true });
    throw error;
  }
};

const validatePayloadEntries = (entries) => {
  if (!Array.isArray(entries) || entries.length < 2) return false;
  let previous = null;
  const caseFolded = new Set();
  for (const entry of entries) {
    if (!entry || !isCanonicalPortablePath(entry.path)) return false;
    if (previous !== null && portablePathCompare(previous, entry.path) >= 0) return false;
    previous = entry.path;
    const folded = entry.path.toLowerCase();
    if (caseFolded.has(folded)) return false;
    caseFolded.add(folded);
    if (entry.type === 'directory') {
      if (Object.keys(entry).sort().join('|') !== 'path|type') return false;
    } else if (entry.type === 'file') {
      if (Object.keys(entry).sort().join('|') !== 'path|sha256|size|type'
          || !Number.isSafeInteger(entry.size) || entry.size < 0 || !HASH.test(entry.sha256 ?? '')) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
};

const readAndVerifyInstallerPackageReceipt = ({
  receiptPath,
  installerPath,
  installedExecutablePath,
  repositoryRoot,
  signaturePath = `${receiptPath}.sig`,
  publicKeyPath = DEFAULT_PUBLIC_KEY_PATH,
  payloadContract = readPayloadContract(repositoryRoot ?? DEFAULT_REPOSITORY_ROOT),
}) => {
  assertIndependentRegularFile(receiptPath, 'installer package receipt');
  const bytes = fs.readFileSync(receiptPath);
  const receiptSignatureSha256 = verifyMinisign({ bytes, signaturePath, publicKeyPath });
  let value;
  try {
    value = JSON.parse(decodeUtf8(bytes, 'installer package receipt'));
  } catch {
    throw new Error('installer package receipt is not valid JSON');
  }
  const executableEntry = Array.isArray(value?.payloadEntries)
    ? value.payloadEntries.find((entry) => entry?.path === EXECUTABLE_NAME)
    : null;
  const uninstallerEntry = Array.isArray(value?.payloadEntries)
    ? value.payloadEntries.find((entry) => entry?.path === UNINSTALLER_NAME)
    : null;
  const expectedSource = repositoryRoot === undefined
    ? null
    : readCleanGitSourceProvenance({ repositoryRoot });
  if (
    value?.schemaVersion !== SCHEMA_VERSION
    || value.publisher !== PUBLISHER
    || Object.keys(value).sort().join('|')
      !== 'applicationHash|installerSha256|payloadEntries|payloadExecutableSha256|publisher|schemaVersion|source'
    || value.source?.dirty !== false
    || Object.keys(value.source ?? {}).sort().join('|') !== 'commit|dirty|tree'
    || !GIT_OBJECT.test(value.source?.commit ?? '')
    || !GIT_OBJECT.test(value.source?.tree ?? '')
    || (expectedSource !== null && (
      value.source.commit !== expectedSource.commit || value.source.tree !== expectedSource.tree
    ))
    || !HASH.test(value.applicationHash ?? '')
    || !HASH.test(value.payloadExecutableSha256 ?? '')
    || !HASH.test(value.installerSha256 ?? '')
    || !validatePayloadEntries(value.payloadEntries)
    || executableEntry?.type !== 'file'
    || uninstallerEntry?.type !== 'file'
    || value.applicationHash !== applicationHashForPayload(value.payloadEntries)
    || value.payloadExecutableSha256 !== executableEntry.sha256
    || value.installerSha256 !== sha256(installerPath, 'installer')
    || !bytes.equals(packageReceiptBytes(value))
    || (() => {
      try {
        assertPayloadContract(value.payloadEntries, payloadContract);
        return false;
      } catch {
        return true;
      }
    })()
    || (installedExecutablePath !== undefined
      && JSON.stringify(value.payloadEntries)
        !== JSON.stringify(payloadInventory(installedExecutablePath, payloadContract)))
  ) throw new Error('installer package receipt does not match its source/package/installed payload');
  return Object.freeze({
    ...value,
    receiptSha256: sha256Bytes(bytes),
    receiptSignatureSha256,
  });
};

if (require.main === module) {
  try {
    const args = new Map();
    for (let index = 2; index < process.argv.length; index += 2) {
      args.set(process.argv[index], process.argv[index + 1]);
    }
    if (args.has('--publish')) {
      const published = publishInstallerPackageReceipt({
        outputPath: args.get('--receipt'),
        installerPath: args.get('--installer'),
        installedExecutablePath: args.get('--installed-exe'),
        repositoryRoot: args.get('--repository-root'),
        publicKeyPath: args.get('--public-key') ?? undefined,
      });
      process.stdout.write(`${JSON.stringify(published)}\n`);
    } else {
      const verified = readAndVerifyInstallerPackageReceipt({
        receiptPath: args.get('--receipt'),
        installerPath: args.get('--installer'),
        installedExecutablePath: args.get('--installed-exe'),
        repositoryRoot: args.get('--repository-root'),
        signaturePath: args.get('--signature') ?? undefined,
        publicKeyPath: args.get('--public-key') ?? undefined,
      });
      process.stdout.write(`${JSON.stringify(verified)}\n`);
    }
  } catch (error) {
    console.error(`Installer package receipt validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  applicationHashForPayload,
  packageReceiptBytes,
  payloadInventory,
  publishInstallerPackageReceipt,
  readPayloadContract,
  readAndVerifyInstallerPackageReceipt,
  readUpdaterMinisignPublicKey,
  validatePayloadEntries,
  verifyMinisign,
};
