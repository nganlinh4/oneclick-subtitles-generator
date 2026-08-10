#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {
  createRenderSurfaceFingerprint,
  createTaggedTemplateFingerprints,
  hashContents,
  isExcludedSource,
} = require('../../scripts/check-visual-freeze.js');

const scriptPath = fileURLToPath(import.meta.url);
const promptDjRoot = path.resolve(path.dirname(scriptPath), '..');
const repositoryRoot = path.resolve(promptDjRoot, '..');
const contractPath = path.join(promptDjRoot, 'visual-contract.json');
const schemaVersion = 2;
const algorithm = 'sha256';
const normalization =
  'shared schema-2 AST; exact text ignores UTF-8 BOM, normalizes CRLF/CR to LF, and ignores terminal newlines';
const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
const binaryVisualExtensions = new Set([
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.otf',
  '.png',
  '.svg',
  '.ttf',
  '.webp',
  '.woff',
  '.woff2',
]);

function repositoryPath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function isExactVisualFile(relativePath) {
  const normalized = repositoryPath(relativePath);
  const extension = path.extname(normalized).toLowerCase();
  return normalized.startsWith('assets/')
    || extension === '.css'
    || binaryVisualExtensions.has(extension)
    || normalized.endsWith('/LoadingIndicator/all-shapes.txt');
}

function isSourceFile(relativePath) {
  return sourceExtensions.has(path.extname(relativePath).toLowerCase())
    && !isExcludedSource(`src/${repositoryPath(relativePath)}`);
}

function visit(directory, files) {
  const entries = fs.readdirSync(directory, {withFileTypes: true})
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const absolutePath = path.join(directory, entry.name);
    const relativePath = repositoryPath(path.relative(promptDjRoot, absolutePath));
    if (entry.isSymbolicLink()) throw new Error(`promptdj visual tree contains a symlink: ${relativePath}`);
    if (entry.isDirectory()) visit(absolutePath, files);
    else if (entry.isFile()) files.push(relativePath);
  }
}

function workingTreeProvider() {
  const files = [];
  visit(promptDjRoot, files);
  files.sort((left, right) => left.localeCompare(right, 'en'));
  return {
    listFiles: () => files,
    readFile: (relativePath) => fs.readFileSync(path.join(promptDjRoot, relativePath)),
  };
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
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

function committedProvider(reference) {
  const revision = git(['rev-parse', '--verify', `${reference}^{commit}`], 'utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`invalid PromptDJ baseline: ${reference}`);
  const prefix = 'promptdj-midi/';
  const files = git(['ls-tree', '-r', '-z', '--name-only', revision, '--', 'promptdj-midi'])
    .toString('utf8')
    .split('\0')
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length))
    .sort((left, right) => left.localeCompare(right, 'en'));
  return {
    revision,
    listFiles: () => files,
    readFile: (relativePath) => git(['show', `${revision}:${prefix}${relativePath}`]),
  };
}

function addFingerprint(record, relativePath, fingerprint) {
  if (fingerprint.rootCount > 0) record[relativePath] = fingerprint;
}

export function createPromptDjManifest(provider, baselineRevision = null) {
  const exactFiles = {};
  const reactSurfaces = {};
  const litRenderSurfaces = {};
  const litStyleSurfaces = {};
  for (const relativePath of provider.listFiles()) {
    if (isExactVisualFile(relativePath)) {
      exactFiles[relativePath] = hashContents(relativePath, provider.readFile(relativePath));
    }
    if (!isSourceFile(relativePath)) continue;
    const source = provider.readFile(relativePath).toString('utf8');
    addFingerprint(
      reactSurfaces,
      relativePath,
      createRenderSurfaceFingerprint(source, relativePath),
    );
    const tagged = createTaggedTemplateFingerprints(source, relativePath);
    addFingerprint(litRenderSurfaces, relativePath, tagged.render);
    addFingerprint(litStyleSurfaces, relativePath, tagged.styles);
  }
  return {
    schemaVersion,
    algorithm,
    normalization,
    baselineRevision,
    exactFiles,
    reactSurfaces,
    litRenderSurfaces,
    litStyleSurfaces,
  };
}

function compareSection(expected, actual) {
  return {
    added: Object.keys(actual).filter((file) => !(file in expected)).sort(),
    removed: Object.keys(expected).filter((file) => !(file in actual)).sort(),
    changed: Object.keys(actual).filter((file) => file in expected && (
      typeof actual[file] === 'string'
        ? actual[file] !== expected[file]
        : actual[file].hash !== expected[file].hash
    )).sort(),
  };
}

export function comparePromptDjManifests(expected, actual) {
  return Object.fromEntries([
    'exactFiles',
    'reactSurfaces',
    'litRenderSurfaces',
    'litStyleSurfaces',
  ].map((section) => [section, compareSection(expected[section] || {}, actual[section] || {})]));
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

function validateContract(contract) {
  if (contract.schemaVersion !== schemaVersion
      || contract.algorithm !== algorithm
      || contract.normalization !== normalization
      || !/^[0-9a-f]{40}$/.test(contract.baselineRevision || '')) {
    throw new Error('invalid-promptdj-visual-contract');
  }
  for (const section of ['exactFiles', 'reactSurfaces', 'litRenderSurfaces', 'litStyleSurfaces']) {
    if (contract[section] === null || typeof contract[section] !== 'object'
        || Array.isArray(contract[section])) {
      throw new Error(`invalid-promptdj-visual-contract:${section}`);
    }
  }
  for (const [file, hash] of Object.entries(contract.exactFiles)) {
    if (!isExactVisualFile(file) || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`invalid-promptdj-exact-entry:${file}`);
    }
  }
  for (const section of ['reactSurfaces', 'litRenderSurfaces', 'litStyleSurfaces']) {
    for (const [file, fingerprint] of Object.entries(contract[section])) {
      if (!isSourceFile(file) || !validFingerprint(fingerprint)) {
        throw new Error(`invalid-promptdj-surface-entry:${section}:${file}`);
      }
    }
  }
}

function changed(changes) {
  return Object.values(changes).some((section) =>
    section.added.length || section.removed.length || section.changed.length);
}

function formatChanges(changes) {
  const labels = {
    exactFiles: 'exact CSS/font/asset',
    reactSurfaces: 'React surface',
    litRenderSurfaces: 'Lit render template',
    litStyleSurfaces: 'Lit CSS template',
  };
  const lines = [];
  for (const [section, entries] of Object.entries(changes)) {
    for (const kind of ['added', 'removed', 'changed']) {
      for (const file of entries[kind]) lines.push(`  - ${kind} ${labels[section]}: ${file}`);
    }
  }
  return lines.join('\n');
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function updateContract(reference) {
  if (!reference) {
    throw new Error('refusing working-tree approval; pass --baseline-ref <reviewed-commit>');
  }
  const provider = committedProvider(reference);
  const contract = createPromptDjManifest(provider, provider.revision);
  validateContract(contract);
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `PromptDJ visual contract written from ${provider.revision}: `
    + `${Object.keys(contract.exactFiles).length} exact files, `
    + `${Object.keys(contract.reactSurfaces).length} React surfaces, `
    + `${Object.keys(contract.litRenderSurfaces).length} Lit render files, `
    + `${Object.keys(contract.litStyleSurfaces).length} Lit style files.\n`,
  );
}

function checkContract() {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  validateContract(contract);
  const actual = createPromptDjManifest(workingTreeProvider());
  const changes = comparePromptDjManifests(contract, actual);
  if (changed(changes)) {
    throw new Error(
      `PromptDJ visuals differ from original committed baseline ${contract.baselineRevision}:\n`
      + formatChanges(changes),
    );
  }
  process.stdout.write(
    `PromptDJ visual contract passed against ${contract.baselineRevision}: `
    + `${Object.keys(contract.exactFiles).length} exact files and `
    + `${Object.keys(contract.reactSurfaces).length
      + Object.keys(contract.litRenderSurfaces).length
      + Object.keys(contract.litStyleSurfaces).length} render/style surfaces.\n`,
  );
}

function main() {
  if (process.argv.includes('--update')) updateContract(argumentValue('--baseline-ref'));
  else checkContract();
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(`PromptDJ visual contract failed: ${error.message}`);
    process.exitCode = 1;
  }
}
