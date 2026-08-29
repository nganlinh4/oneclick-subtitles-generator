import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  futimesSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  readSync,
  readdirSync,
  statSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import { REPOSITORY_ROOT } from './environment.js';

const PLATFORM = 'windows-x86_64';
const TOOL_IDS = Object.freeze(['media-tools', 'yt-dlp', 'deno']);
const CATALOG_PATH = join(
  REPOSITORY_ROOT, 'crates', 'osg-native-tools', 'delivery', 'native-tools.delivery.json',
);
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
  : resolve(left) === resolve(right);
const exactKeys = (value, keys) => value !== null && typeof value === 'object'
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');

const readJson = (path, maxBytes = 4 * 1024 * 1024) => {
  const metadata = lstatSync(path);
  assert.equal(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1, true,
    `native-tool JSON is not one ordinary file: ${path}`);
  assert.ok(metadata.size > 0 && metadata.size <= maxBytes,
    `native-tool JSON exceeds its bounded schema size: ${path}`);
  const actual = resolve(realpathSync.native(path));
  const expected = resolve(path);
  assert.equal(process.platform === 'win32' ? actual.toLowerCase() : actual,
    process.platform === 'win32' ? expected.toLowerCase() : expected,
    `native-tool JSON crosses a redirected path: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
};

const sha256File = (path) => {
  const digest = crypto.createHash('sha256');
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

const assertInside = (root, candidate) => {
  const path = resolve(root, candidate);
  const remainder = relative(root, path);
  assert.ok(
    remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${sep}`)
      && !isAbsolute(remainder),
    `native-tool receipt escaped its version root: ${candidate}`,
  );
  return path;
};

const regularFiles = (root, current = root) => readdirSync(current, { withFileTypes: true })
  .flatMap((entry) => {
    const path = join(current, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `native-tool install contains a link: ${path}`);
    if (entry.isDirectory()) return regularFiles(root, path);
    assert.equal(entry.isFile(), true, `native-tool install contains a non-file: ${path}`);
    return relative(root, path).split(sep).join('/');
  });

const staticDelivery = (tool, version) => {
  const catalog = readJson(CATALOG_PATH);
  const entry = catalog.tools.find(({ id }) => id === tool);
  assert.ok(entry, `native-tool catalog omitted ${tool}`);
  const release = entry.platforms?.[PLATFORM]?.releases?.find(
    (candidate) => candidate.version === version,
  );
  if (!release) return null;
  return {
    tool,
    platform: PLATFORM,
    version,
    sourceRevision: entry.sourceRevision,
    asset: release.artifact.asset,
    sourceUrl: release.artifact.sourceUrl,
    format: release.artifact.format,
    selectiveExtraction: release.artifact.selectiveExtraction,
    sizeBytes: release.artifact.sizeBytes,
    sha256: release.artifact.sha256,
    files: release.files,
    notices: entry.notices,
  };
};

const validYtDlpVersion = (version) => {
  const pieces = String(version).split('.');
  if (pieces.length !== 3 && pieces.length !== 4) return false;
  const [yearRaw, monthRaw, dayRaw, timeRaw] = pieces;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (
    !/^[0-9]{4}$/u.test(yearRaw) || year < 2020 || year > 2200
    || !/^[0-9]{2}$/u.test(monthRaw) || month < 1 || month > 12
    || !/^[0-9]{2}$/u.test(dayRaw) || day < 1 || day > 31
  ) return false;
  if (timeRaw === undefined) return true;
  if (!/^[0-9]{6}$/u.test(timeRaw)) return false;
  const time = Number(timeRaw);
  return Math.floor(time / 10_000) <= 23
    && Math.floor(time / 100) % 100 <= 59
    && time % 100 <= 59;
};

const validDynamicYtDlpDelivery = (delivery) => {
  const file = delivery?.files?.[0];
  const notices = delivery?.notices;
  const releaseUrls = ['yt-dlp/yt-dlp', 'yt-dlp/yt-dlp-nightly-builds'].map(
    (repository) => `https://github.com/${repository}/releases/download/${delivery?.version}/yt-dlp.exe`,
  );
  const noticePrefix = `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${delivery?.sourceRevision}/`;
  const installedBytes = Number.isSafeInteger(delivery?.sizeBytes) && Array.isArray(notices)
    ? notices.reduce((total, notice) => total + notice.sizeBytes, delivery.sizeBytes)
    : Number.NaN;
  return delivery?.tool === 'yt-dlp'
    && exactKeys(delivery, [
      'asset', 'files', 'format', 'installedBytes', 'notices', 'platform',
      'selectiveExtraction', 'sha256', 'sizeBytes', 'sourceRevision', 'sourceUrl', 'tool', 'version',
    ])
    && delivery.platform === PLATFORM
    && validYtDlpVersion(delivery.version)
    && /^[0-9a-f]{40}$/u.test(delivery.sourceRevision)
    && delivery.asset === 'yt-dlp.exe'
    && delivery.format === 'raw'
    && delivery.selectiveExtraction === false
    && Number.isSafeInteger(delivery.sizeBytes)
    && delivery.sizeBytes > 0
    && delivery.sizeBytes <= 512 * 1024 * 1024
    && HEX_SHA256.test(delivery.sha256)
    && releaseUrls.includes(delivery.sourceUrl)
    && delivery.files?.length === 1
    && exactKeys(file, ['installPath', 'role', 'sha256', 'sizeBytes', 'sourcePath'])
    && file.sourcePath === 'yt-dlp.exe'
    && file.installPath === 'bin/yt-dlp.exe'
    && file.sizeBytes === delivery.sizeBytes
    && file.sha256 === delivery.sha256
    && file.role === 'yt-dlp'
    && notices?.length === 2
    && notices.every((notice) => exactKeys(
      notice, ['installPath', 'sha256', 'sizeBytes', 'sourceUrl'],
    ))
    && notices[0]?.installPath === 'licenses/yt-dlp-LICENSE.txt'
    && notices[1]?.installPath === 'licenses/yt-dlp-THIRD-PARTY.txt'
    && notices.every((notice) => Number.isSafeInteger(notice.sizeBytes)
      && notice.sizeBytes > 0
      && notice.sizeBytes <= 4 * 1024 * 1024
      && HEX_SHA256.test(notice.sha256)
      && notice.sourceUrl.startsWith(noticePrefix))
    && notices[0].sourceUrl === `${noticePrefix}LICENSE`
    && notices[1].sourceUrl === `${noticePrefix}THIRD_PARTY_LICENSES.txt`
    && Number.isSafeInteger(installedBytes)
    && installedBytes <= 1024 * 1024 * 1024
    && delivery.installedBytes === installedBytes;
};

export const installedDynamicYtDlpDeliveries = (storeRoot) => {
  const deliveriesRoot = join(storeRoot, 'v1', 'tools', 'yt-dlp', 'deliveries');
  if (!existsSync(deliveriesRoot)) return Object.freeze([]);
  const deliveriesMetadata = lstatSync(deliveriesRoot);
  assert.equal(
    deliveriesMetadata.isDirectory()
      && !deliveriesMetadata.isSymbolicLink()
      && samePath(realpathSync.native(deliveriesRoot), deliveriesRoot),
    true,
    'yt-dlp dynamic deliveries root is redirected or not one ordinary directory',
  );
  const entries = readdirSync(deliveriesRoot, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  assert.ok(entries.length <= 64, 'yt-dlp dynamic delivery record count exceeds manager bound');
  const deliveries = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    try {
      const record = readJson(join(deliveriesRoot, entry.name), 1024 * 1024);
      if (
        exactKeys(record, ['delivery', 'githubImmutableRelease', 'schemaVersion'])
        && record.schemaVersion === 1
        && record.githubImmutableRelease === true
        && validDynamicYtDlpDelivery(record.delivery)
      ) deliveries.push(record.delivery);
    } catch {
      // NativeToolManager::load_installed deliberately skips invalid records.
    }
  }
  deliveries.sort((left, right) => (
    left.version < right.version ? 1 : left.version > right.version ? -1 : 0
  ));
  const unique = deliveries.filter((delivery, index) => (
    index === 0 || delivery.version !== deliveries[index - 1].version
  ));
  return Object.freeze(unique);
};

const dynamicDelivery = (storeRoot, tool, version) => {
  if (tool !== 'yt-dlp') return null;
  return installedDynamicYtDlpDeliveries(storeRoot).find(
    (delivery) => delivery.version === version,
  ) ?? null;
};

const currentDeliveryVersion = (storeRoot, tool) => {
  if (tool === 'yt-dlp') {
    const [dynamic] = installedDynamicYtDlpDeliveries(storeRoot);
    // NativeToolManager::current_delivery uses update::load_installed's first valid delivery,
    // sorted by raw version string descending; the record filename is intentionally irrelevant.
    if (dynamic !== undefined) return dynamic.version;
  }
  const catalog = readJson(CATALOG_PATH);
  const entry = catalog.tools.find(({ id }) => id === tool);
  const version = entry?.platforms?.[PLATFORM]?.releases?.[0]?.version;
  assert.equal(typeof version, 'string', `the reviewed catalog has no current ${tool} delivery`);
  return version;
};

const expectedReceipt = (delivery) => ({
  schemaVersion: 1,
  tool: delivery.tool,
  platform: delivery.platform,
  version: delivery.version,
  sourceRevision: delivery.sourceRevision,
  artifactSha256: delivery.sha256,
  files: [
    ...delivery.files.map((file) => ({
      path: file.installPath,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      executable: file.role !== null,
      role: file.role,
    })),
    ...delivery.notices.map((file) => ({
      path: file.installPath,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      executable: false,
      role: null,
    })),
  ],
});

const verifyNativeToolVersion = ({ storeRoot, tool, version }) => {
  assert.match(version, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  const delivery = staticDelivery(tool, version) ?? dynamicDelivery(storeRoot, tool, version);
  assert.ok(delivery, `no reviewed delivery owns ${tool} ${version}`);
  assert.equal(delivery.tool, tool);
  assert.equal(delivery.platform, PLATFORM);
  assert.equal(delivery.version, version);
  assert.match(delivery.sha256, HEX_SHA256);

  const versionRoot = join(storeRoot, 'v1', 'tools', tool, 'versions', version);
  const receiptPath = join(versionRoot, 'receipt.json');
  const receipt = readJson(receiptPath);
  const expected = expectedReceipt(delivery);
  assert.deepEqual(receipt, expected, `${tool} receipt differs from its reviewed delivery`);
  assert.deepEqual(
    regularFiles(versionRoot).sort(),
    [...expected.files.map(({ path }) => path), 'receipt.json'].sort(),
    `${tool} installed tree contains missing or undeclared files`,
  );

  const files = expected.files.map((file) => {
    assert.match(file.sha256, HEX_SHA256);
    const absolutePath = assertInside(versionRoot, file.path);
    const metadata = lstatSync(absolutePath);
    assert.equal(metadata.isSymbolicLink(), false, `${tool} file is a link: ${file.path}`);
    assert.equal(metadata.isFile(), true, `${tool} file is not regular: ${file.path}`);
    assert.equal(metadata.nlink, 1, `${tool} file is multiply linked: ${file.path}`);
    assert.equal(metadata.size, file.sizeBytes, `${tool} file size differs: ${file.path}`);
    const sha256 = sha256File(absolutePath);
    assert.equal(sha256, file.sha256, `${tool} file digest differs: ${file.path}`);
    return Object.freeze({ ...file, absolutePath, sha256 });
  });
  return Object.freeze({
    tool,
    version,
    versionRoot,
    receiptPath,
    receiptSha256: sha256File(receiptPath),
    files: Object.freeze(files),
  });
};

/**
 * Resolve one executable only after its complete installed tree and receipt match the reviewed
 * delivery catalog. The persistent E2E store deliberately has no ambient PATH fallback.
 */
export const resolveVerifiedNativeToolRoles = ({ storeRoot, tool, roles }) => {
  assert.ok(TOOL_IDS.includes(tool), `unknown native tool: ${tool}`);
  assert.ok(Array.isArray(roles) && roles.length > 0 && roles.every((role) => typeof role === 'string'));
  assert.equal(new Set(roles).size, roles.length, `${tool} requested duplicate executable roles`);
  const version = currentDeliveryVersion(storeRoot, tool);
  const verified = verifyNativeToolVersion({ storeRoot, tool, version });
  return Object.freeze(Object.fromEntries(roles.map((role) => {
    const matches = verified.files.filter((file) => file.role === role && file.executable);
    assert.equal(matches.length, 1, `${tool} has no unique reviewed ${role} executable`);
    return [role, matches[0].absolutePath];
  })));
};

export const resolveVerifiedNativeToolExecutable = ({ storeRoot, tool, role }) => (
  resolveVerifiedNativeToolRoles({ storeRoot, tool, roles: [role] })[role]
);

export const nativeToolsStore = (runRoot) => join(runRoot, 'data', 'native-tools');

export const verifyNativeToolsInstall = (runRoot, versions) => {
  assert.deepEqual(Object.keys(versions).sort(), [...TOOL_IDS].sort());
  const storeRoot = nativeToolsStore(runRoot);
  const tools = {};
  for (const tool of TOOL_IDS) {
    const version = versions[tool];
    const verified = verifyNativeToolVersion({ storeRoot, tool, version });
    const files = verified.files.map(({ absolutePath, ...file }) => {
      void absolutePath;
      return file;
    });
    tools[tool] = Object.freeze({
      version,
      relativeVersionRoot: relative(runRoot, verified.versionRoot),
      receiptSha256: verified.receiptSha256,
      files: Object.freeze(files),
    });
  }
  return Object.freeze({ schemaVersion: 1, tools: Object.freeze(tools) });
};

export const tamperInstalledTool = (runRoot, proof, tool = 'yt-dlp') => {
  const entry = proof?.tools?.[tool];
  assert.ok(entry, `native-tool proof omitted ${tool}`);
  const file = entry.files.find(({ executable }) => executable);
  assert.ok(file, `${tool} proof omitted its executable`);
  const versionRoot = assertInside(runRoot, entry.relativeVersionRoot);
  const path = assertInside(versionRoot, file.path);
  const before = statSync(path);
  assert.equal(before.size, file.sizeBytes);
  assert.equal(sha256File(path), file.sha256);

  const descriptor = openSync(path, 'r+');
  try {
    const offset = Math.floor(before.size / 2);
    const byte = Buffer.alloc(1);
    assert.equal(readSync(descriptor, byte, 0, 1, offset), 1);
    byte[0] ^= 0xff;
    assert.equal(writeSync(descriptor, byte, 0, 1, offset), 1);
    fsyncSync(descriptor);
    futimesSync(descriptor, before.atime, before.mtime);
  } finally {
    closeSync(descriptor);
  }
  const after = statSync(path);
  const tamperedSha256 = sha256File(path);
  assert.equal(after.size, before.size, 'tamper must preserve installed file size');
  assert.notEqual(tamperedSha256, file.sha256, 'tamper did not change the installed digest');
  return Object.freeze({ tool, path: relative(runRoot, path), tamperedSha256 });
};
