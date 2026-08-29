import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  publishE2eApplication: publishApplicationWithoutTestProvenance,
} = require('../../scripts/e2e-application-publication.js');
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const gitObject = (revision) => {
  const result = spawnSync('git', ['rev-parse', '--verify', revision], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const TEST_SOURCE_PROVENANCE = Object.freeze({
  commit: gitObject('HEAD'),
  tree: gitObject('HEAD^{tree}'),
  dirty: false,
});
const publishE2eApplication = (input) => publishApplicationWithoutTestProvenance({
  ...input,
  sourceProvenance: input.sourceProvenance ?? TEST_SOURCE_PROVENANCE,
});
const { readCurrentWindowsProcessIdentity } = require('../../scripts/windows-process-identity.js');

const guardedWindowsGuiFixture = () => {
  const guards = [
    'The automation build refused an unstaged native file dialog.',
    'The automation build requires a non-focusable off-screen native window.',
    'the automation build refused an unsafe harness environment:',
    '--mute-audio',
    'The automation build refused an interactive desktop surface.',
    'The OSG automation WebDriver refuses native-window mutation and unidentified sessions.',
  ];
  const bytes = Buffer.alloc(2_048);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(64, 0x3c);
  bytes.set(Buffer.from([0x50, 0x45, 0, 0]), 64);
  bytes.writeUInt16LE(0x20b, 64 + 24);
  bytes.writeUInt16LE(2, 64 + 24 + 68);
  Buffer.from(guards.join('\n')).copy(bytes, 256);
  return bytes;
};

const createCargoProfile = (root) => {
  const profile = join(root, 'cargo-profile');
  for (const directory of ['licenses', 'ui-fonts', 'workers', 'workers/nested']) {
    mkdirSync(join(profile, directory), { recursive: true });
  }
  writeFileSync(join(profile, 'osg-desktop.exe'), guardedWindowsGuiFixture());
  writeFileSync(join(profile, 'licenses', 'LICENSE'), 'license\n');
  writeFileSync(join(profile, 'ui-fonts', `${'a'.repeat(64)}.woff2`), 'font bytes\n');
  writeFileSync(join(profile, 'workers', 'nested', 'worker.py'), 'print("worker")\n');
  return profile;
};

const root = mkdtempSync(join(tmpdir(), 'osg-published-harness-test-'));
const managedCacheRoot = join(root, 'managed-cache');
const applicationsCacheRoot = join(managedCacheRoot, 'apps', 'e2e');
const profileRoot = createCargoProfile(root);
const publication = publishE2eApplication({ profileRoot, applicationsCacheRoot });
const priorCacheRoot = process.env.OSG_DEV_CACHE_ROOT;
const priorBinary = process.env.OSG_E2E_BINARY;
process.env.OSG_DEV_CACHE_ROOT = managedCacheRoot;
delete process.env.OSG_E2E_BINARY;

const environment = await import('./environment.js');
const leases = await import('./applicationLease.js');
const staging = await import('./stageApplication.js');

test.after(() => {
  if (priorCacheRoot === undefined) delete process.env.OSG_DEV_CACHE_ROOT;
  else process.env.OSG_DEV_CACHE_ROOT = priorCacheRoot;
  if (priorBinary === undefined) delete process.env.OSG_E2E_BINARY;
  else process.env.OSG_E2E_BINARY = priorBinary;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test('default launches resolve only through the verified external application receipt', () => {
  assert.equal(environment.DEVELOPMENT_CACHE_ROOT, resolve(managedCacheRoot));
  assert.equal(environment.E2E_APPLICATIONS_CACHE_ROOT, applicationsCacheRoot);
  assert.equal(environment.BUILT_APPLICATION_DIRECTORY, publication.applicationRoot);
  assert.equal(environment.APPLICATION_BINARY, publication.binaryPath);
  assert.deepEqual(
    environment.readVerifiedPublishedApplication(),
    {
      applicationHash: publication.applicationHash,
      applicationRoot: publication.applicationRoot,
      binaryPath: publication.binaryPath,
      manifestPath: publication.manifestPath,
      receiptPath: publication.receiptPath,
      fileCount: publication.fileCount,
      totalBytes: publication.totalBytes,
      sourceProvenance: TEST_SOURCE_PROVENANCE,
    },
  );
  assert.doesNotThrow(() => environment.assertAutomationDialogGuard(publication.binaryPath));
});

test('launch publication provenance must equal the exact current clean commit and tree', () => {
  assert.equal(
    environment.assertPublicationMatchesCurrentSource(publication, TEST_SOURCE_PROVENANCE),
    publication,
  );
  assert.throws(
    () => environment.assertPublicationMatchesCurrentSource(publication, {
      ...TEST_SOURCE_PROVENANCE,
      commit: '3'.repeat(40),
    }),
    /does not match the current clean source commit\/tree/u,
  );
  assert.throws(
    () => environment.assertPublicationMatchesCurrentSource(publication, {
      ...TEST_SOURCE_PROVENANCE,
      tree: '4'.repeat(40),
    }),
    /does not match the current clean source commit\/tree/u,
  );
  assert.throws(
    () => environment.assertPublicationMatchesCurrentSource(publication, {
      ...TEST_SOURCE_PROVENANCE,
      dirty: true,
    }),
    /does not match the current clean source commit\/tree/u,
  );
});

test('development cache resolution rejects relative, traversal, repository, and ancestor roots', () => {
  const repository = resolve(import.meta.dirname, '..', '..');
  const drivePath = join(repository, 'target', 'external-looking');
  for (const requested of [
    'relative-cache',
    `${join(root, 'safe')}\\..\\escape`,
    drivePath,
    dirname(repository),
    `\\\\?\\${drivePath}`,
    '\\\\?\\UNC\\server\\share\\osg-cache',
    `\\\\.\\${drivePath}`,
    `\\??\\${drivePath}`,
    `\\\\??\\${drivePath}`,
    `\\DeViCe\\${drivePath}`,
    `\\\\DeViCe\\${drivePath}`,
    `\\GLOBAL??\\${drivePath}`,
    `\\\\GLOBAL??\\${drivePath}`,
    `${join(root, 'trailing-dot.')}\\cache`,
    `${join(root, 'trailing-space ')}\\cache`,
  ]) {
    assert.throws(
      () => environment.resolveDevelopmentCacheRoot({
        environment: { OSG_DEV_CACHE_ROOT: requested },
        repositoryRoot: repository,
      }),
      /absolute path without traversal|external to the repository/u,
    );
  }
  if (process.platform === 'win32') {
    const alias = join(root, 'repository-alias');
    symlinkSync(repository, alias, 'junction');
    assert.throws(
      () => environment.resolveDevelopmentCacheRoot({
        environment: { OSG_DEV_CACHE_ROOT: join(alias, 'target', 'alias-cache') },
        repositoryRoot: repository,
      }),
      /redirected filesystem path/u,
      'an ordinary-looking junction alias must not bypass the repository overlap check',
    );
  }
});

test('damaged-install staging copies the verified immutable publication and nothing from Cargo', () => {
  const staged = staging.stageApplication({
    testStagingRoot: join(root, 'test-staging'),
  });
  try {
    assert.notEqual(staged, profileRoot);
    assert.notEqual(staged, publication.applicationRoot);
    assert.deepEqual(
      readFileSync(join(staged, 'workers', 'nested', 'worker.py')),
      readFileSync(join(publication.applicationRoot, 'workers', 'nested', 'worker.py')),
    );
    const binary = staging.stagedBinary(staged);
    assert.doesNotThrow(() => environment.assertStagedApplicationBinary(binary));
    const [font] = staging.stagedFontResources(staged);
    staging.corruptFontResource(staged, font);
    const derivative = staging.describeStagedApplicationDerivative({
      staged,
      publication,
      expectedPath: `ui-fonts/${font}`,
      expectedChange: 'changed',
    });
    assert.equal(derivative.baseApplicationHash, publication.applicationHash);
    assert.equal(derivative.delta.path, `ui-fonts/${font}`);
    assert.equal(derivative.delta.change, 'changed');
    assert.equal(derivative.files.some(({ path }) => path === `ui-fonts/${font}`), true);
    assert.match(derivative.treeSha256, /^[0-9a-f]{64}$/u);
    assert.doesNotThrow(() => staging.assertStagedApplicationDerivative({
      staged, publication, derivative,
    }));
    mkdirSync(join(staged, 'unexpected-empty-directory'));
    assert.throws(
      () => staging.assertStagedApplicationDerivative({ staged, publication, derivative }),
      /changed the canonical directory inventory/u,
    );
    rmSync(join(staged, 'unexpected-empty-directory'), { recursive: true });
    writeFileSync(join(staged, 'workers', 'nested', 'worker.py'), 'second unrecorded mutation');
    assert.throws(
      () => staging.assertStagedApplicationDerivative({ staged, publication, derivative }),
      /exactly one changed|changed after its canonical inventory was sealed/u,
    );
    assert.doesNotThrow(
      () => environment.assertStagedApplicationBinary(binary),
      'intentional payload damage must not invalidate the private staging authority',
    );
  } finally {
    staging.discardStagedApplication(staged);
  }
});

test('an undamaged staged copy cannot cross-bless itself with an arbitrary damage label', () => {
  const testStagingRoot = join(root, 'undamaged-derivative-staging');
  const staged = staging.stageApplication({ testStagingRoot });
  try {
    const [font] = staging.stagedFontResources(staged);
    assert.throws(
      () => staging.describeStagedApplicationDerivative({
        staged,
        publication,
        expectedPath: `ui-fonts/${font}`,
        expectedChange: 'deleted',
      }),
      /damage must be exactly one changed or deleted base file/u,
    );
  } finally {
    staging.discardStagedApplication(staged);
  }
});

test('staged-application cleanup refuses an arbitrary or redirected caller path', () => {
  const foreign = join(root, 'foreign-staged-lookalike');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, 'osg-desktop.exe'), guardedWindowsGuiFixture());

  assert.throws(
    () => staging.discardStagedApplication(foreign),
    /direct private staged-application root|authority marker/u,
  );
  assert.equal(existsSync(join(foreign, 'osg-desktop.exe')), true);
});

test('the managed application lease validates its lane and releases exactly once', () => {
  const calls = [];
  const acquire = (options) => {
    calls.push(['acquire', options]);
    return {
      leaseId: '1'.repeat(32),
      appPublicationRoot: applicationsCacheRoot,
      assetCacheRoot: environment.E2E_ASSET_CACHE_ROOT,
    };
  };
  const release = (options) => calls.push(['release', options]);
  const prune = (options) => calls.push(['prune', options]);
  const lease = leases.acquireE2eApplicationLease({
    acquire,
    prune,
    release,
    processId: 42,
    repositoryRoot: resolve(import.meta.dirname, '..', '..'),
    cacheRoot: managedCacheRoot,
    applicationsCacheRoot,
  });
  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false);
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], 'acquire');
  assert.equal(calls[0][1].processId, 42);
  assert.deepEqual(calls[1], [
    'release',
    {
      repositoryRoot: resolve(import.meta.dirname, '..', '..'),
      cacheRoot: managedCacheRoot,
      leaseId: '1'.repeat(32),
    },
  ]);
  assert.deepEqual(calls[2], [
    'prune',
    {
      repositoryRoot: resolve(import.meta.dirname, '..', '..'),
      cacheRoot: managedCacheRoot,
      protectE2e: false,
      protectApplication: true,
    },
  ]);
});

test('WDIO children validate inherited hash, path, owner PID, creation time, and active marker', () => {
  const leaseId = '3'.repeat(32);
  const { processCreatedUtc: created } = readCurrentWindowsProcessIdentity();
  const markerPath = join(applicationsCacheRoot, '.osg-cache-lease');
  writeFileSync(markerPath, `${JSON.stringify({
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId: '4'.repeat(32),
    laneGroup: 'e2e',
    leaseId,
    processId: process.pid,
    processCreatedUtc: created,
  })}\n`);
  try {
    const encoded = leases.serializeInheritedApplicationLease({
      lease: {
        leaseId,
        leaseOwnerProcessId: process.pid,
        leaseOwnerProcessCreatedUtc: created,
        applicationsCacheRoot,
      },
      publication,
    });
    const inherited = leases.readInheritedApplicationLease({
      environment: { [leases.INHERITED_APPLICATION_LEASE]: encoded },
      readPublication: environment.readVerifiedPublishedApplication,
    });
    assert.equal(inherited.publication.applicationHash, publication.applicationHash);
    const staleOwner = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    staleOwner.leaseOwnerProcessCreatedUtc = '2026-01-01T00:00:00.0000000Z';
    assert.throws(() => leases.readInheritedApplicationLease({
      environment: {
        [leases.INHERITED_APPLICATION_LEASE]: Buffer.from(
          JSON.stringify(staleOwner),
        ).toString('base64'),
      },
      readPublication: environment.readVerifiedPublishedApplication,
    }), /owner identity is stale or was reused/u);
    const hostile = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    hostile.applicationHash = 'f'.repeat(64);
    assert.throws(() => leases.readInheritedApplicationLease({
      environment: {
        [leases.INHERITED_APPLICATION_LEASE]: Buffer.from(JSON.stringify(hostile)).toString('base64'),
      },
      readPublication: environment.readVerifiedPublishedApplication,
    }), /no longer matches/u);
  } finally {
    rmSync(markerPath, { force: true });
  }
});

test('a lease for another application lane is released and refused', () => {
  let released = false;
  assert.throws(
    () => leases.acquireE2eApplicationLease({
      acquire: () => ({
        leaseId: '2'.repeat(32),
        appPublicationRoot: join(managedCacheRoot, 'apps', 'package'),
        assetCacheRoot: environment.E2E_ASSET_CACHE_ROOT,
      }),
      release: () => { released = true; },
      repositoryRoot: resolve(import.meta.dirname, '..', '..'),
      cacheRoot: managedCacheRoot,
      applicationsCacheRoot,
    }),
    /wrong application publication root/u,
  );
  assert.equal(released, true);
});

test('a lease for another asset lane is released and refused', () => {
  let released = false;
  assert.throws(
    () => leases.acquireE2eApplicationLease({
      acquire: () => ({
        leaseId: '3'.repeat(32),
        appPublicationRoot: applicationsCacheRoot,
        assetCacheRoot: join(managedCacheRoot, 'assets', 'package'),
      }),
      release: () => { released = true; },
      repositoryRoot: resolve(import.meta.dirname, '..', '..'),
      cacheRoot: managedCacheRoot,
      applicationsCacheRoot,
    }),
    /wrong asset cache root/u,
  );
  assert.equal(released, true);
});

test('an operation error is preserved when post-lease pruning also fails', () => {
  const primary = new Error('operation failed');
  const cleanup = new Error('prune failed');
  assert.throws(
    () => leases.withE2eApplicationLease(() => { throw primary; }, {
      acquire: () => ({
        leaseId: '4'.repeat(32),
        appPublicationRoot: applicationsCacheRoot,
        assetCacheRoot: environment.E2E_ASSET_CACHE_ROOT,
      }),
      release: () => undefined,
      prune: () => { throw cleanup; },
      repositoryRoot: resolve(import.meta.dirname, '..', '..'),
      cacheRoot: managedCacheRoot,
      applicationsCacheRoot,
    }),
    (error) => error instanceof AggregateError
      && error.errors[0] === primary
      && error.errors[1] === cleanup,
  );
});

test('an arbitrary executable cannot use the staged-only OSG_E2E_BINARY override', () => {
  assert.throws(
    () => environment.assertStagedApplicationBinary(join(profileRoot, 'osg-desktop.exe')),
    /private staged-application root/u,
  );
});

test('a missing publication remains non-launchable without falling back to a repository target', () => {
  const missingRoot = join(root, 'missing-managed-cache');
  const environmentUrl = pathToFileURL(join(import.meta.dirname, 'environment.js'));
  const script = [
    `const environment = await import(${JSON.stringify(environmentUrl.href)});`,
    'if (environment.APPLICATION_BINARY.includes("target")) throw new Error("repo fallback");',
    'environment.assertAutomationDialogGuard(environment.APPLICATION_BINARY);',
  ].join('\n');
  const childEnvironment = { ...process.env, OSG_DEV_CACHE_ROOT: missingRoot };
  delete childEnvironment.OSG_E2E_BINARY;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: childEnvironment,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(child.status, 0, 'a missing receipt unexpectedly reached a launchable binary');
  assert.match(child.stderr, /current\.json|ENOENT|receipt/u);
  assert.equal(existsSync(join(missingRoot, 'apps', 'e2e', 'receipts', 'current.json')), false);
});

test('the real cache manager lease protects a verified publication through launch preflight', {
  skip: process.platform !== 'win32',
}, () => {
  const leasedCacheRoot = join(root, 'manager-owned-cache');
  const managerPath = join(repositoryRoot, 'scripts', 'dev-cache.ps1');
  const manager = spawnSync('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-File', managerPath,
    '-Action', 'Lease',
    '-LeaseOperation', 'Acquire',
    '-Lane', 'e2e',
    '-LeaseProcessId', String(process.pid),
    '-CacheRoot', leasedCacheRoot,
    '-OutputFormat', 'Json',
  ], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
  assert.equal(manager.status, 0, manager.stderr);
  const contract = JSON.parse(manager.stdout.trim());
  publishE2eApplication({
    profileRoot,
    applicationsCacheRoot: contract.appPublicationRoot,
    retentionLeaseId: contract.leaseId,
  });
  const released = spawnSync('pwsh', [
    '-NoProfile', '-NonInteractive', '-File', managerPath,
    '-Action', 'Lease', '-LeaseOperation', 'Release', '-Lane', 'e2e',
    '-LeaseId', contract.leaseId,
    '-CacheRoot', leasedCacheRoot,
  ], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
  assert.equal(released.status, 0, released.stderr);
  const environmentUrl = pathToFileURL(join(import.meta.dirname, 'environment.js'));
  const leaseUrl = pathToFileURL(join(import.meta.dirname, 'applicationLease.js'));
  const script = [
    `const environment = await import(${JSON.stringify(environmentUrl.href)});`,
    `const leases = await import(${JSON.stringify(leaseUrl.href)});`,
    'const lease = leases.acquireE2eApplicationLease();',
    'try { environment.assertAutomationDialogGuard(environment.APPLICATION_BINARY); }',
    'finally { lease.release(); }',
  ].join('\n');
  const childEnvironment = { ...process.env, OSG_DEV_CACHE_ROOT: leasedCacheRoot };
  delete childEnvironment.OSG_E2E_BINARY;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repositoryRoot,
    env: childEnvironment,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
});

test('receipt or application corruption is rejected before the compile-time guard is trusted', () => {
  const font = join(
    publication.applicationRoot,
    'ui-fonts',
    `${'a'.repeat(64)}.woff2`,
  );
  writeFileSync(font, 'mutated font bytes\n');
  assert.throws(
    () => environment.assertAutomationDialogGuard(environment.APPLICATION_BINARY),
    /corrupted inventory/u,
  );
});
