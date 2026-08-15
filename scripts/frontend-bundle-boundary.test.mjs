import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from '@babel/parser';

import {
  FRONTEND_ENTRY_CHUNK_MAX_BYTES,
  FRONTEND_INITIAL_JS_MAX_BYTES,
  INTENTIONAL_ASYNC_BOUNDARIES,
  REQUIRED_EFFECTIVE_ASYNC_BOUNDARIES,
  assertAsyncBoundarySetsDisjoint,
  auditFrontendBundle,
  createFrontendCodeSplitting,
  handleFrontendBuildLog,
  isIntentionalAsyncBoundaryWarning,
} from './frontend-bundle-boundary.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(repositoryRoot, 'src');
const normalized = (value) => value.replaceAll('\\', '/');

const chunk = ({ fileName, name, code, imports = [], isEntry = false }) => ({
  type: 'chunk',
  fileName,
  name,
  code,
  imports,
  isEntry,
});

const passingBundle = () => ({
  'assets/index.js': chunk({
    fileName: 'assets/index.js',
    name: 'index',
    code: 'e'.repeat(1_000_000),
    imports: ['assets/react.js', 'assets/remotion.js', 'assets/vendor.js'],
    isEntry: true,
  }),
  'assets/react.js': chunk({ fileName: 'assets/react.js', name: 'react', code: 'r'.repeat(100_000) }),
  'assets/remotion.js': chunk({ fileName: 'assets/remotion.js', name: 'remotion', code: 'm'.repeat(200_000) }),
  'assets/vendor.js': chunk({ fileName: 'assets/vendor.js', name: 'vendor', code: 'v'.repeat(200_000) }),
});

test('bundle budget accepts one bounded entry with deterministic framework chunks', () => {
  assert.deepEqual(auditFrontendBundle(passingBundle()), {
    entryBytes: 1_000_000,
    initialBytes: 1_500_000,
    initialChunkCount: 4,
  });
  assert.deepEqual(
    createFrontendCodeSplitting().groups.map(({ name, priority }) => ({ name, priority })),
    [
      { name: 'react', priority: 40 },
      { name: 'remotion', priority: 30 },
      { name: 'vendor', priority: 20 },
    ]
  );
});

test('bundle budget rejects entry growth, aggregate growth, and missing boundaries', () => {
  const oversizedEntry = passingBundle();
  oversizedEntry['assets/index.js'].code = 'x'.repeat(FRONTEND_ENTRY_CHUNK_MAX_BYTES + 1);
  assert.throws(() => auditFrontendBundle(oversizedEntry), /entry is .* budget/);

  const oversizedInitial = passingBundle();
  oversizedInitial['assets/vendor.js'].code = 'x'.repeat(FRONTEND_INITIAL_JS_MAX_BYTES);
  assert.throws(() => auditFrontendBundle(oversizedInitial), /initial JavaScript is .* budget/);

  const missingBoundary = passingBundle();
  missingBoundary['assets/vendor.js'].name = 'misc';
  assert.throws(() => auditFrontendBundle(missingBoundary), /required vendor chunk is missing/);
});

test('only reviewed ineffective dynamic imports are silenced', () => {
  const reviewed = {
    code: 'INEFFECTIVE_DYNAMIC_IMPORT',
    id: 'C:\\repo\\src\\services\\subtitleCache.js',
  };
  assert.equal(isIntentionalAsyncBoundaryWarning(reviewed), true);

  let forwarded = false;
  handleFrontendBuildLog('warn', reviewed, () => { forwarded = true; });
  assert.equal(forwarded, false);

  assert.throws(
    () => handleFrontendBuildLog('warn', {
      code: 'INEFFECTIVE_DYNAMIC_IMPORT',
      id: '/repo/src/services/unreviewed.js',
    }, () => undefined),
    /outside the reviewed async boundaries/
  );

  handleFrontendBuildLog('warn', { code: 'SOME_OTHER_WARNING' }, () => { forwarded = true; });
  assert.equal(forwarded, true);
});

test('required-effective boundaries cannot enter the warning suppression set', () => {
  assert.doesNotThrow(() => assertAsyncBoundarySetsDisjoint(
    INTENTIONAL_ASYNC_BOUNDARIES,
    REQUIRED_EFFECTIVE_ASYNC_BOUNDARIES
  ));

  const [requiredTarget] = Object.keys(REQUIRED_EFFECTIVE_ASYNC_BOUNDARIES);
  const hostileIntentionalBoundaries = {
    ...INTENTIONAL_ASYNC_BOUNDARIES,
    [requiredTarget]: Object.freeze({ 'src/hostileImporter.js': 1 }),
  };
  assert.throws(
    () => assertAsyncBoundarySetsDisjoint(
      hostileIntentionalBoundaries,
      REQUIRED_EFFECTIVE_ASYNC_BOUNDARIES
    ),
    /Required-effective async boundaries cannot be warning-suppressed: .*lifecycleOrchestrator/
  );

  for (const hostileTarget of [
    'services/lifecycleOrchestrator.js',
    'lifecycleOrchestrator.js',
    'SRC/SERVICES/LIFECYCLEORCHESTRATOR.JS',
  ]) {
    assert.throws(
      () => assertAsyncBoundarySetsDisjoint(
        {
          ...INTENTIONAL_ASYNC_BOUNDARIES,
          [hostileTarget]: Object.freeze({ 'src/hostileImporter.js': 1 }),
        },
        REQUIRED_EFFECTIVE_ASYNC_BOUNDARIES
      ),
      /canonical repository path|Required-effective async boundaries cannot be warning-suppressed/i,
      hostileTarget
    );
  }

  for (const nonCanonicalTarget of [
    'src\\services\\lifecycleOrchestrator.js',
    './src/services/lifecycleOrchestrator.js',
    'src/services/./lifecycleOrchestrator.js',
    'src/other/../services/lifecycleOrchestrator.js',
    '../src/services/lifecycleOrchestrator.js',
    '/repo/src/services/lifecycleOrchestrator.js',
    'C:/repo/src/services/lifecycleOrchestrator.js',
    'src/services/lifecycleOrchestrator.js?raw',
    'src/services/lifecycleOrchestrator.js#reviewed',
  ]) {
    assert.throws(
      () => assertAsyncBoundarySetsDisjoint(
        {
          ...INTENTIONAL_ASYNC_BOUNDARIES,
          [nonCanonicalTarget]: Object.freeze({ 'src/hostileImporter.js': 1 }),
        },
        REQUIRED_EFFECTIVE_ASYNC_BOUNDARIES
      ),
      /canonical repository path/,
      nonCanonicalTarget
    );
  }

  for (const nearMiss of [
    'src/services/lifecycleOrchestrator.js.bak',
    'src/services/notLifecycleOrchestrator.js',
  ]) {
    assert.doesNotThrow(() => assertAsyncBoundarySetsDisjoint(
      {
        ...INTENTIONAL_ASYNC_BOUNDARIES,
        [nearMiss]: Object.freeze({ 'src/hostileImporter.js': 1 }),
      },
      REQUIRED_EFFECTIVE_ASYNC_BOUNDARIES
    ));
  }

  for (const target of Object.keys(REQUIRED_EFFECTIVE_ASYNC_BOUNDARIES)) {
    assert.equal(isIntentionalAsyncBoundaryWarning({
      code: 'INEFFECTIVE_DYNAMIC_IMPORT',
      id: `C:\\repo\\${target.replaceAll('/', '\\')}`,
    }), false, `${target} must never be warning-suppressed`);
  }
});

const sourceFiles = () => {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:js|jsx)$/.test(entry.name) && !entry.name.includes('.test.')) files.push(path);
    }
  };
  visit(sourceRoot);
  return files;
};

const resolveDynamicTarget = (importer, specifier) => {
  if (specifier === 'jszip') return 'node_modules/jszip/dist/jszip.min.js';
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(importer), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.jsx`, join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return normalized(relative(repositoryRoot, candidate));
    }
  }
  return null;
};

const collectDynamicBoundaryCounts = (boundaries) => {
  const actual = Object.fromEntries(
    Object.keys(boundaries).map((target) => [target, {}])
  );
  const dynamicImport = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

  for (const file of sourceFiles()) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(dynamicImport)) {
      const target = resolveDynamicTarget(file, match[2]);
      if (!target || !(target in actual)) continue;
      const importer = normalized(relative(repositoryRoot, file));
      actual[target][importer] = (actual[target][importer] ?? 0) + 1;
    }
  }

  return actual;
};

const staticModuleSpecifiers = (source, filename = 'source.js') => {
  const program = parse(source, {
    plugins: ['jsx'],
    sourceFilename: filename,
    sourceType: 'module',
  }).program;
  return program.body.flatMap((node) => (
    (node.type === 'ImportDeclaration'
      || node.type === 'ExportAllDeclaration'
      || node.type === 'ExportNamedDeclaration')
      && typeof node.source?.value === 'string'
      ? [node.source.value]
      : []
  ));
};

const requiredEffectiveTargets = new Set(Object.keys(REQUIRED_EFFECTIVE_ASYNC_BOUNDARIES));
const requiredEffectiveTargetsByBaseName = new Map([...requiredEffectiveTargets].map((target) => [
  target.split('/').at(-1).replace(/\.js$/, ''),
  target,
]));
const resolveRequiredEffectiveTarget = (importer, specifier) => {
  const cleanSpecifier = normalized(specifier).split(/[?#]/, 1)[0];
  const baseName = cleanSpecifier.split('/').at(-1).replace(/\.js$/, '');
  const target = resolveDynamicTarget(importer, specifier)
    ?? requiredEffectiveTargetsByBaseName.get(baseName)
    ?? null;
  return target && requiredEffectiveTargets.has(target) ? target : null;
};

test('reviewed async boundary source pairs and counts cannot drift silently', () => {
  assert.deepEqual(
    collectDynamicBoundaryCounts(INTENTIONAL_ASYNC_BOUNDARIES),
    INTENTIONAL_ASYNC_BOUNDARIES
  );
});

test('required-effective boundaries have exact dynamic edges and no static edge', () => {
  assert.deepEqual(
    collectDynamicBoundaryCounts(REQUIRED_EFFECTIVE_ASYNC_BOUNDARIES),
    REQUIRED_EFFECTIVE_ASYNC_BOUNDARIES
  );

  const staticEdges = [];
  for (const file of sourceFiles()) {
    const importer = normalized(relative(repositoryRoot, file));
    const source = readFileSync(file, 'utf8');
    for (const specifier of staticModuleSpecifiers(source, importer)) {
      const target = resolveRequiredEffectiveTarget(file, specifier);
      if (target) staticEdges.push({ importer, target });
    }
  }

  assert.deepEqual(staticEdges, []);
});

test('required-effective static-edge scan covers imports, re-exports, and side effects', () => {
  assert.deepEqual(staticModuleSpecifiers(`
    import { one } from './one.js';
    import './side-effect.js';
    export { two } from './two.js';
    export * from './all.js';
    const lazy = () => import('./lazy.js');
  `), ['./one.js', './side-effect.js', './two.js', './all.js']);
  assert.equal(
    resolveRequiredEffectiveTarget(
      join(sourceRoot, 'example.js'),
      '@/services/lifecycleOrchestrator?reviewed=false'
    ),
    'src/services/lifecycleOrchestrator.js'
  );
});
