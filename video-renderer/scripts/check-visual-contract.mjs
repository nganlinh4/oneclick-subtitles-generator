import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {
  createRenderSurfaceFingerprint,
  isExcludedSource,
} = require('../../scripts/check-visual-freeze.js');

const rendererRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(rendererRoot, '..');
const contractPath = path.join(rendererRoot, 'visual-contract.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const packageManifest = JSON.parse(
  fs.readFileSync(path.join(rendererRoot, 'package.json'), 'utf8'),
);
const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);

function fail(message) {
  throw new Error(message);
}

function validFingerprint(value) {
  return value !== null
    && typeof value === 'object'
    && /^[0-9a-f]{64}$/.test(value.hash || '')
    && Number.isSafeInteger(value.rootCount)
    && value.rootCount > 0
    && Array.isArray(value.roots)
    && value.roots.length === value.rootCount
    && value.roots.every((root) => /^[0-9a-f]{64}$/.test(root));
}

if (contract.schemaVersion !== 2
    || contract.normalization !== 'utf8-lf'
    || contract.files === null
    || typeof contract.files !== 'object'
    || Array.isArray(contract.files)
    || Object.keys(contract.files).length === 0
    || contract.originalVisualBaseline === null
    || typeof contract.originalVisualBaseline !== 'object'
    || !/^[0-9a-f]{40}$/.test(contract.originalVisualBaseline.revision || '')
    || contract.originalVisualBaseline.fingerprint !== 'frontend-schema-2-render-surface'
    || contract.originalVisualBaseline.renderSurfaces === null
    || typeof contract.originalVisualBaseline.renderSurfaces !== 'object'
    || Array.isArray(contract.originalVisualBaseline.renderSurfaces)
    || Object.keys(contract.originalVisualBaseline.renderSurfaces).length === 0) {
  fail('invalid-render-visual-contract');
}

function exactHash(contents) {
  return crypto.createHash('sha256')
    .update(contents.toString('utf8').replaceAll('\r\n', '\n'))
    .digest('hex');
}

for (const [relativePath, expected] of Object.entries(contract.files)) {
  if (!/^[A-Za-z0-9._/-]+$/.test(relativePath)
      || relativePath.includes('..')
      || !/^[0-9a-f]{64}$/.test(expected)) {
    fail('invalid-render-visual-contract-entry');
  }
  const absolutePath = path.resolve(rendererRoot, relativePath);
  if (!absolutePath.startsWith(`${rendererRoot}${path.sep}`)) {
    fail('invalid-render-visual-contract-path');
  }
  const actual = exactHash(fs.readFileSync(absolutePath));
  if (actual !== expected) fail(`render-exact-contract-changed:${relativePath}`);
}

for (const [relativePath, fingerprint] of Object.entries(
  contract.originalVisualBaseline.renderSurfaces,
)) {
  if (!/^[A-Za-z0-9._/-]+$/.test(relativePath)
      || relativePath.includes('..')
      || !validFingerprint(fingerprint)) {
    fail(`invalid-render-original-surface:${relativePath}`);
  }
}

function sourceFilesFromDirectory() {
  const files = [];
  function visit(directory) {
    const entries = fs.readdirSync(directory, {withFileTypes: true})
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(rendererRoot, absolutePath).split(path.sep).join('/');
      if (entry.isSymbolicLink()) fail(`render-source-symlink:${relativePath}`);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()
          && sourceExtensions.has(path.extname(relativePath).toLowerCase())
          && !isExcludedSource(relativePath)) files.push(relativePath);
    }
  }
  visit(path.join(rendererRoot, 'src'));
  return files;
}

function assertStyledComponentsBoundary() {
  if (packageManifest.dependencies?.['styled-components'] !== '6.5.1') {
    fail('render-styled-components-pin-changed');
  }
  const consumers = sourceFilesFromDirectory().filter((relativePath) => {
    const source = fs.readFileSync(path.join(rendererRoot, relativePath), 'utf8');
    return /(?:from\s*['"]styled-components['"]|require\(\s*['"]styled-components['"]\s*\))/.test(
      source,
    );
  });
  if (consumers.length !== 1 || consumers[0] !== 'src/components/SubtitledVideo.tsx') {
    fail(`render-styled-components-boundary-changed:${consumers.join(',')}`);
  }
}

function currentRenderSurfaces() {
  const surfaces = {};
  for (const relativePath of sourceFilesFromDirectory()) {
    const source = fs.readFileSync(path.join(rendererRoot, relativePath), 'utf8');
    const fingerprint = createRenderSurfaceFingerprint(source, relativePath);
    if (fingerprint.rootCount > 0) surfaces[relativePath] = fingerprint;
  }
  return surfaces;
}

function git(args, encoding) {
  try {
    return execFileSync('git', args, {
      cwd: repositoryRoot,
      encoding,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString('utf8').trim() : error.message;
    fail(`render-baseline-git-failed:${detail}`);
  }
}

function committedRenderSurfaces(revision) {
  const prefix = 'video-renderer/';
  const files = git(['ls-tree', '-r', '--name-only', revision, '--', 'video-renderer/src'], 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => sourceExtensions.has(path.extname(file).toLowerCase()))
    .map((file) => file.slice(prefix.length))
    .filter((file) => !isExcludedSource(file));
  const surfaces = {};
  for (const relativePath of files) {
    const source = git(['show', `${revision}:${prefix}${relativePath}`], 'utf8');
    const fingerprint = createRenderSurfaceFingerprint(source, relativePath);
    if (fingerprint.rootCount > 0) surfaces[relativePath] = fingerprint;
  }
  return surfaces;
}

function compareSurfaces(expected, actual, failurePrefix) {
  const added = Object.keys(actual).filter((file) => !(file in expected)).sort();
  const removed = Object.keys(expected).filter((file) => !(file in actual)).sort();
  const changed = Object.keys(actual)
    .filter((file) => file in expected && actual[file].hash !== expected[file].hash)
    .sort();
  if (added.length || removed.length || changed.length) {
    const details = [
      ...added.map((file) => `added:${file}`),
      ...removed.map((file) => `removed:${file}`),
      ...changed.map((file) => `changed:${file}`),
    ].join(',');
    fail(`${failurePrefix}:${details}`);
  }
}

const original = contract.originalVisualBaseline;
assertStyledComponentsBoundary();
if (process.argv.includes('--verify-provenance')) {
  const resolvedRevision = git(
    ['rev-parse', '--verify', `${original.revision}^{commit}`],
    'utf8',
  ).trim();
  if (resolvedRevision !== original.revision) fail('render-original-revision-is-not-canonical');
  // This explicit audit proves the stored semantic baseline came from the
  // recorded original OSG commit. The normal gate does not require historical
  // Git objects, so it remains usable in a shallow CI checkout.
  compareSurfaces(
    original.renderSurfaces,
    committedRenderSurfaces(original.revision),
    'render-original-provenance-mismatch',
  );
}
compareSurfaces(
  original.renderSurfaces,
  currentRenderSurfaces(),
  'render-original-visual-drift',
);

process.stdout.write(
  `Remotion visual contract passed: ${Object.keys(contract.files).length} exact current files and `
  + `${Object.keys(original.renderSurfaces).length} render surfaces match original ${original.revision}`
  + `${process.argv.includes('--verify-provenance') ? ' (provenance verified)' : ''}.\n`,
);
