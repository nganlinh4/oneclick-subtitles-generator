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
  readSync,
  readdirSync,
  statSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { REPOSITORY_ROOT } from './environment.js';

const PLATFORM = 'windows-x86_64';
const TOOL_IDS = Object.freeze(['media-tools', 'yt-dlp', 'deno']);
const CATALOG_PATH = join(
  REPOSITORY_ROOT, 'crates', 'osg-native-tools', 'delivery', 'native-tools.delivery.json',
);
const HEX_SHA256 = /^[a-f0-9]{64}$/;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const sha256File = (path) => crypto.createHash('sha256').update(readFileSync(path)).digest('hex');

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

const dynamicDelivery = (storeRoot, tool, version) => {
  if (tool !== 'yt-dlp') return null;
  const path = join(storeRoot, 'v1', 'tools', tool, 'deliveries', `${version}.json`);
  if (!existsSync(path)) return null;
  const record = readJson(path);
  assert.deepEqual(
    { schemaVersion: record.schemaVersion, githubImmutableRelease: record.githubImmutableRelease },
    { schemaVersion: 1, githubImmutableRelease: true },
    'dynamic yt-dlp delivery is not an immutable reviewed record',
  );
  return record.delivery;
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

export const nativeToolsStore = (runRoot) => join(runRoot, 'data', 'native-tools');

export const verifyNativeToolsInstall = (runRoot, versions) => {
  assert.deepEqual(Object.keys(versions).sort(), [...TOOL_IDS].sort());
  const storeRoot = nativeToolsStore(runRoot);
  const tools = {};
  for (const tool of TOOL_IDS) {
    const version = versions[tool];
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
      const path = assertInside(versionRoot, file.path);
      const metadata = lstatSync(path);
      assert.equal(metadata.isSymbolicLink(), false, `${tool} file is a link: ${file.path}`);
      assert.equal(metadata.isFile(), true, `${tool} file is not regular: ${file.path}`);
      assert.equal(metadata.size, file.sizeBytes, `${tool} file size differs: ${file.path}`);
      const sha256 = sha256File(path);
      assert.equal(sha256, file.sha256, `${tool} file digest differs: ${file.path}`);
      return Object.freeze({ ...file, sha256 });
    });
    tools[tool] = Object.freeze({
      version,
      relativeVersionRoot: relative(runRoot, versionRoot),
      receiptSha256: sha256File(receiptPath),
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
