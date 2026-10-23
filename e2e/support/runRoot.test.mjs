// Disposable run roots: cache junctions and policy, asset lanes, reuse authority and cleanup.

import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

import {
  E2E_ASSET_CACHE_ROOT, ENGINE_PACKAGES_CACHE, EVIDENCE_CACHE_ROOT, FOUR_WINDOW_ASR_MEDIA_CACHE,
  attachRunRootCaches, canReuseRunRoot, createRunRoot, NATIVE_TOOLS_CACHE, REAL_MEDIA_CACHE,
  removeRunRoot, runRootAuthorization, SOURCE_SWITCH_MEDIA_CACHE,
} from './environment.js';

const TEST_STAGING_ROOT = mkdtempSync(join(tmpdir(), 'osg-e2e-test-staging-'));
test.after(() => rmSync(TEST_STAGING_ROOT, { recursive: true, force: true }));
const createTestRunRoot = (options = {}) => createRunRoot({
  ...options,
  testStagingRoot: TEST_STAGING_ROOT,
});
test('isolated roots retain engine packages through a junction without deleting the cache', () => {
  const cacheScratch = mkdtempSync(join(tmpdir(), 'osg-e2e-engine-cache-test-'));
  const enginePackagesCache = join(cacheScratch, 'engine-packages');
  const root = createTestRunRoot({ keepNativeTools: false });
  const rootAuthorization = runRootAuthorization(root);
  const junction = join(root, 'data', 'engine-packages');
  try {
    assert.equal(lstatSync(junction, { throwIfNoEntry: false }), undefined);
    assert.equal(existsSync(enginePackagesCache), false);
    assert.deepEqual(attachRunRootCaches({
      root,
      nativeToolsCache: join(cacheScratch, 'native-tools'),
      enginePackagesCache,
    }), { keepNativeTools: false, keepEnginePackages: true });
    assert.equal(lstatSync(junction).isSymbolicLink(), true);
    assert.equal(existsSync(enginePackagesCache), true);
  } finally {
    removeRunRoot(root, rootAuthorization);
  }
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(enginePackagesCache), true);
  rmSync(cacheScratch, { recursive: true, force: true });
});

test('a from-empty engine/tool policy stays detached until the leased launcher applies it', () => {
  const cacheScratch = mkdtempSync(join(tmpdir(), 'osg-e2e-disabled-cache-test-'));
  const nativeToolsCache = join(cacheScratch, 'native-tools');
  const enginePackagesCache = join(cacheScratch, 'engine-packages');
  const root = createTestRunRoot({ keepNativeTools: false, keepEnginePackages: false });
  const rootAuthorization = runRootAuthorization(root);
  try {
    assert.deepEqual(attachRunRootCaches({ root, nativeToolsCache, enginePackagesCache }), {
      keepNativeTools: false,
      keepEnginePackages: false,
    });
    assert.equal(existsSync(nativeToolsCache), false);
    assert.equal(existsSync(enginePackagesCache), false);
    assert.equal(lstatSync(join(root, 'data', 'native-tools'), { throwIfNoEntry: false }), undefined);
    assert.equal(
      lstatSync(join(root, 'data', 'engine-packages'), { throwIfNoEntry: false }),
      undefined,
    );
  } finally {
    removeRunRoot(root, rootAuthorization);
    rmSync(cacheScratch, { recursive: true, force: true });
  }
});

test('a disabled cache accepts the application-created in-root store but never a link', () => {
  const cacheScratch = mkdtempSync(join(tmpdir(), 'osg-e2e-disabled-store-test-'));
  const nativeToolsCache = join(cacheScratch, 'native-tools');
  const enginePackagesCache = join(cacheScratch, 'engine-packages');
  const root = createTestRunRoot({ keepNativeTools: false, keepEnginePackages: false });
  const rootAuthorization = runRootAuthorization(root);
  const store = join(root, 'data', 'native-tools');
  try {
    // The launcher's service spawns the application before this config runs again in the worker,
    // and the application creates its store directory eagerly. Re-attaching must accept it.
    mkdirSync(store, { recursive: true });
    assert.deepEqual(attachRunRootCaches({ root, nativeToolsCache, enginePackagesCache }), {
      keepNativeTools: false,
      keepEnginePackages: false,
    });
    assert.equal(existsSync(nativeToolsCache), false);
    // A link at the same path could reach a shared persistent cache and must stay refused.
    rmSync(store, { recursive: true, force: true });
    mkdirSync(nativeToolsCache, { recursive: true });
    symlinkSync(nativeToolsCache, store, 'junction');
    assert.throws(
      () => attachRunRootCaches({ root, nativeToolsCache, enginePackagesCache }),
      /attached the disabled native-tools cache/u,
    );
  } finally {
    removeRunRoot(root, rootAuthorization);
    rmSync(cacheScratch, { recursive: true, force: true });
  }
});

test('every retained E2E asset is below the one external manager-owned lane', () => {
  for (const assetPath of [
    NATIVE_TOOLS_CACHE,
    ENGINE_PACKAGES_CACHE,
    REAL_MEDIA_CACHE,
    SOURCE_SWITCH_MEDIA_CACHE,
    FOUR_WINDOW_ASR_MEDIA_CACHE,
  ]) {
    const inside = relative(resolve(E2E_ASSET_CACHE_ROOT), resolve(assetPath));
    assert.ok(
      inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside),
      `${assetPath} escaped the managed E2E asset lane`,
    );
    assert.doesNotMatch(
      assetPath,
      /[\\/]target[\\/]e2e-|[\\/]target[\\/]workflow-evidence/iu,
    );
  }
});

test('workflow evidence has its own external manager lane instead of sharing application assets', () => {
  assert.equal(EVIDENCE_CACHE_ROOT, join(resolve(E2E_ASSET_CACHE_ROOT, '..', '..'), 'evidence'));
  assert.notEqual(resolve(EVIDENCE_CACHE_ROOT), resolve(E2E_ASSET_CACHE_ROOT));
  assert.doesNotMatch(EVIDENCE_CACHE_ROOT, /[\\/]target[\\/]workflow-evidence/iu);
});

test('an isolated profile can be reused only with its authority and an approved process role', () => {
  const root = createTestRunRoot({ keepNativeTools: false, keepEnginePackages: false });
  const authorization = runRootAuthorization(root);
  const enclosing = mkdtempSync(join(tmpdir(), 'osg-e2e-container-'));
  try {
    const base = { OSG_E2E_DATA_ROOT: root };

    assert.equal(canReuseRunRoot({ environment: base, workerProcess: false }), false);
    assert.equal(canReuseRunRoot({
      environment: { ...base, OSG_E2E_REUSE_ROOT: '1' },
      workerProcess: false,
    }), false);
    assert.equal(canReuseRunRoot({
      environment: {
        ...base,
        OSG_E2E_REUSE_ROOT: '1',
        OSG_E2E_RUN_ROOT_AUTHORIZATION: '0'.repeat(64),
      },
      workerProcess: false,
    }), false);
    assert.equal(canReuseRunRoot({
      environment: {
        ...base,
        OSG_E2E_REUSE_ROOT: '1',
        OSG_E2E_RUN_ROOT_AUTHORIZATION: authorization,
      },
      workerProcess: false,
    }), true);
    assert.equal(canReuseRunRoot({
      environment: {
        ...base,
        WDIO_WORKER_ID: '0-0',
        OSG_E2E_RUN_ROOT_AUTHORIZATION: authorization,
      },
      workerProcess: true,
    }), true);
    assert.equal(canReuseRunRoot({
      environment: { ...base, OSG_E2E_RUN_ROOT_AUTHORIZATION: authorization },
      workerProcess: true,
    }), false);

    const lookalike = join(enclosing, 'osg-e2e-lookalike');
    for (const child of [
      '', 'data', 'cache', 'logs', 'webview', 'evidence', 'input', 'output',
    ]) {
      mkdirSync(join(lookalike, child), { recursive: true });
    }
    writeFileSync(join(lookalike, '.osg-e2e-authority'), authorization);
    assert.equal(canReuseRunRoot({
      environment: {
        OSG_E2E_DATA_ROOT: lookalike,
        OSG_E2E_REUSE_ROOT: '1',
        OSG_E2E_RUN_ROOT_AUTHORIZATION: authorization,
      },
      workerProcess: false,
    }), false, 'a token cannot authorize a lookalike profile outside the direct OS temp boundary');
  } finally {
    removeRunRoot(root, authorization);
    rmSync(enclosing, { recursive: true, force: true });
  }
});

test('production run roots cannot fall back to the operating-system temp directory', () => {
  assert.throws(
    () => createRunRoot({ keepNativeTools: false, keepEnginePackages: false }),
    /managed staging lease or test root/u,
  );
  const root = createTestRunRoot({ keepNativeTools: false, keepEnginePackages: false });
  const rootAuthorization = runRootAuthorization(root);
  try {
    assert.equal(resolve(root).startsWith(`${resolve(TEST_STAGING_ROOT)}${sep}`), true);
  } finally {
    removeRunRoot(root, rootAuthorization);
  }
});

test('run-root cleanup refuses hostile paths and mismatched private authority', () => {
  const root = createTestRunRoot({ keepNativeTools: false, keepEnginePackages: false });
  const authorization = runRootAuthorization(root);
  const hostile = mkdtempSync(join(tmpdir(), 'osg-e2e-cleanup-hostile-'));
  const sentinel = join(hostile, 'must-survive.txt');
  writeFileSync(sentinel, 'foreign bytes');
  try {
    assert.throws(
      () => removeRunRoot(hostile, authorization),
      /without its exact private authority/u,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'foreign bytes');
    assert.throws(
      () => removeRunRoot(root, '0'.repeat(64)),
      /without its exact private authority/u,
    );
    assert.equal(existsSync(root), true);
  } finally {
    removeRunRoot(root, authorization);
    rmSync(hostile, { recursive: true, force: true });
  }
});

test('the cache policy cannot be widened after an isolated root is authorized', () => {
  const root = createTestRunRoot({ keepNativeTools: false, keepEnginePackages: false });
  try {
    const policyPath = join(root, '.osg-e2e-cache-policy.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    policy.keepNativeTools = true;
    writeFileSync(policyPath, `${JSON.stringify(policy)}\n`);
    assert.throws(() => runRootAuthorization(root), /required private temporary layout/u);
    assert.throws(
      () => attachRunRootCaches({
        root,
        nativeToolsCache: join(root, 'forbidden-native-tools'),
        enginePackagesCache: join(root, 'forbidden-engine-packages'),
      }),
      /required private temporary layout/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
