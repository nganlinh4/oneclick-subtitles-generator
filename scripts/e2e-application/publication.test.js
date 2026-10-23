'use strict';

// Publishing, source provenance, schema migration, and concurrent publishers.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');

const {
  APPLICATION_BINARY,
  RESOURCE_DIRECTORIES,
  collectCargoProfileApplication,
  publishE2eApplication: publishApplicationWithoutTestProvenance,
  readAndVerifyE2eApplicationReceipt,
} = require('../e2e-application-publication');
const {
  TEST_SOURCE_PROVENANCE,
  publishE2eApplication,
  sleep,
  temporaryRoot,
  writeFile,
  writeHistoricalV2Application,
  writeManagedAppLease,
  writeProfile,
} = require('./test-fixtures');

const execFileAsync = promisify(execFile);

test('unchanged publication preserves mtimes and one byte creates a new immutable application', async (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'external-applications-cache');
  writeProfile(profile);

  const first = publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cache });
  const tracked = path.join(first.applicationRoot, 'workers', 'osg_asr_worker.py');
  const firstTimes = {
    application: fs.statSync(first.applicationRoot).mtimeMs,
    file: fs.statSync(tracked).mtimeMs,
    manifest: fs.statSync(first.manifestPath).mtimeMs,
    receipt: fs.statSync(first.receiptPath).mtimeMs,
  };
  assert.equal(fs.existsSync(path.join(first.applicationRoot, 'deps')), false);
  assert.equal(fs.existsSync(path.join(first.applicationRoot, 'osg_desktop.pdb')), false);
  assert.deepEqual(
    readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }),
    {
      applicationHash: first.applicationHash,
      applicationRoot: first.applicationRoot,
      binaryPath: first.binaryPath,
      manifestPath: first.manifestPath,
      receiptPath: first.receiptPath,
      fileCount: first.fileCount,
      totalBytes: first.totalBytes,
      sourceProvenance: TEST_SOURCE_PROVENANCE,
    },
  );

  await sleep(40);
  const second = publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cache });
  assert.equal(second.applicationHash, first.applicationHash);
  assert.equal(second.applicationCreated, false);
  assert.equal(second.receiptChanged, false);
  assert.deepEqual({
    application: fs.statSync(first.applicationRoot).mtimeMs,
    file: fs.statSync(tracked).mtimeMs,
    manifest: fs.statSync(first.manifestPath).mtimeMs,
    receipt: fs.statSync(first.receiptPath).mtimeMs,
  }, firstTimes);

  const oldWorker = fs.readFileSync(tracked);
  fs.writeFileSync(path.join(profile, 'workers', 'osg_asr_worker.py'), Buffer.from('worker-alphb'));
  const third = publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cache });
  assert.notEqual(third.applicationHash, first.applicationHash);
  assert.ok(fs.readFileSync(tracked).equals(oldWorker));
  assert.equal(
    fs.readFileSync(path.join(third.applicationRoot, 'workers', 'osg_asr_worker.py'), 'utf8'),
    'worker-alphb',
  );
  assert.equal(
    readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }).applicationHash,
    third.applicationHash,
  );
});

test('source provenance is content-addressed and receipt drift fails closed', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  writeProfile(profile, 'provenance');

  assert.throws(
    () => publishApplicationWithoutTestProvenance({
      profileRoot: profile,
      applicationsCacheRoot: cache,
    }),
    /source provenance/u,
  );
  assert.equal(fs.existsSync(cache), false);

  const first = publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cache });
  const secondSource = {
    commit: '3'.repeat(40),
    tree: TEST_SOURCE_PROVENANCE.tree,
    dirty: false,
  };
  const second = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    sourceProvenance: secondSource,
  });
  assert.notEqual(second.applicationHash, first.applicationHash);
  assert.deepEqual(
    readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }).sourceProvenance,
    secondSource,
  );

  const receipt = JSON.parse(fs.readFileSync(second.receiptPath, 'utf8'));
  receipt.source.commit = TEST_SOURCE_PROVENANCE.commit;
  fs.writeFileSync(second.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  assert.throws(
    () => readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }),
    /receipt path\/hash or inventory/u,
  );
});

test('schema v2 publishes beside an untouched legacy v1 application and selects the v2 root', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  writeProfile(profile, 'legacy-source');
  const collected = collectCargoProfileApplication(profile);
  const legacyManifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    hashAlgorithm: 'sha256',
    entrypoint: APPLICATION_BINARY,
    resourceDirectories: RESOURCE_DIRECTORIES,
    directories: collected.directories,
    files: collected.files.map(({ path: relative, size, sha256 }) => ({
      path: relative,
      size,
      sha256,
    })),
  }, null, 2)}\n`, 'utf8');
  const legacyHash = createHash('sha256').update(legacyManifest).digest('hex');
  const legacyRoot = path.join(cache, 'applications', legacyHash);
  for (const relative of collected.directories) {
    fs.mkdirSync(path.join(legacyRoot, ...relative.split('/')), { recursive: true });
  }
  for (const entry of collected.files) {
    const output = path.join(legacyRoot, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(entry.source, output);
  }
  const legacyManifestPath = path.join(cache, 'manifests', `${legacyHash}.json`);
  fs.mkdirSync(path.dirname(legacyManifestPath), { recursive: true });
  fs.writeFileSync(legacyManifestPath, legacyManifest);
  const legacyReceiptPath = path.join(cache, 'receipts', 'current.json');
  fs.mkdirSync(path.dirname(legacyReceiptPath), { recursive: true });
  fs.writeFileSync(legacyReceiptPath, `${JSON.stringify({
    schemaVersion: 1,
    applicationHash: legacyHash,
    applicationRoot: legacyRoot,
  })}\n`);
  const legacyBinaryBefore = fs.readFileSync(path.join(legacyRoot, APPLICATION_BINARY));
  const legacyManifestBefore = fs.readFileSync(legacyManifestPath);
  const leaseId = writeManagedAppLease(cache, 'd'.repeat(32));

  const published = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });
  assert.notEqual(published.applicationHash, legacyHash);
  assert.notEqual(published.applicationRoot, legacyRoot);
  assert.ok(fs.readFileSync(path.join(legacyRoot, APPLICATION_BINARY)).equals(legacyBinaryBefore));
  assert.ok(fs.readFileSync(legacyManifestPath).equals(legacyManifestBefore));
  assert.equal(fs.existsSync(path.join(legacyRoot, '.osg-application-manifest.json')), false);
  assert.deepEqual(
    fs.readdirSync(path.join(cache, 'applications')).sort(),
    [legacyHash, published.applicationHash].sort(),
  );
  assert.equal(
    readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }).applicationHash,
    published.applicationHash,
  );
});

test('a source-bound publication migrates a provenance-less v2 receipt as historical', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  writeProfile(profile, 'historical-v2');
  const historical = writeHistoricalV2Application({ cache, profile });
  const leaseId = writeManagedAppLease(cache, 'e'.repeat(32));

  const published = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });
  assert.notEqual(published.applicationHash, historical.hash);
  assert.equal(fs.existsSync(historical.applicationRoot), true);
  assert.deepEqual(
    readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }).sourceProvenance,
    TEST_SOURCE_PROVENANCE,
  );
});


test('a Cargo hardlink is accepted but published files are independent', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  writeProfile(profile);
  const seed = path.join(root, 'cargo-seed.exe');
  fs.renameSync(path.join(profile, 'osg-desktop.exe'), seed);
  fs.linkSync(seed, path.join(profile, 'osg-desktop.exe'));
  assert.ok(fs.statSync(path.join(profile, 'osg-desktop.exe')).nlink >= 2);

  const result = publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cache });
  assert.equal(fs.statSync(result.binaryPath).nlink, 1);
  fs.writeFileSync(seed, Buffer.from('changed-through-cargo-hardlink'));
  assert.equal(fs.readFileSync(result.binaryPath, 'utf8'), 'MZ-e2e-alpha');
});

test('interruption and a changing Cargo profile preserve the previous receipt', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  writeProfile(profile, 'one');
  const first = publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cache });
  const receiptBefore = fs.readFileSync(first.receiptPath);

  writeProfile(profile, 'two');
  assert.throws(() => publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    failAt: 'before-application-commit',
  }), /injected interruption before application commit/u);
  assert.ok(fs.readFileSync(first.receiptPath).equals(receiptBefore));
  assert.deepEqual(fs.readdirSync(path.join(cache, 'applications')), [first.applicationHash]);
  assert.equal(fs.statSync(first.manifestPath).nlink, 1);

  assert.throws(() => publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    afterCopy: () => fs.writeFileSync(
      path.join(profile, 'workers', 'late.py'),
      'appeared during publication',
    ),
  }), /Cargo profile changed while/u);
  assert.ok(fs.readFileSync(first.receiptPath).equals(receiptBefore));

  fs.rmSync(path.join(profile, 'workers', 'late.py'));
  writeProfile(profile, 'three');
  assert.throws(() => publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    failAt: 'before-receipt-commit',
  }), /injected interruption before receipt commit/u);
  assert.ok(fs.readFileSync(first.receiptPath).equals(receiptBefore));
  const verified = readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache });
  assert.equal(verified.applicationHash, first.applicationHash);
  assert.equal(fs.readFileSync(verified.binaryPath, 'utf8'), 'MZ-e2e-one');
  assert.equal(
    fs.readdirSync(path.join(cache, 'applications'))
      .filter((name) => name.startsWith('.publish-')).length,
    0,
  );
});

test('concurrent identical publishers converge on one verified immutable application', async (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  const repository = path.join(root, 'source-repository');
  fs.mkdirSync(repository);
  execFileSync('git', ['init', '--quiet'], { cwd: repository, windowsHide: true });
  writeFile(repository, 'tracked.txt', 'source');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repository, windowsHide: true });
  execFileSync('git', [
    '-c', 'user.name=OSG Test', '-c', 'user.email=osg@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ], { cwd: repository, windowsHide: true });
  writeProfile(profile, 'concurrent');
  for (let index = 0; index < 40; index += 1) {
    writeFile(profile, `workers/nested/${String(index).padStart(2, '0')}.txt`, `file-${index}`);
  }
  const script = path.resolve(__dirname, '..', 'e2e-application-publication.js');
  const invocations = Array.from({ length: 8 }, () => execFileAsync(process.execPath, [
    script,
    '--profile-root', profile,
    '--applications-cache-root', cache,
    '--repository-root', repository,
  ], { encoding: 'utf8', windowsHide: true }));
  const results = (await Promise.all(invocations)).map(({ stdout }) => JSON.parse(stdout));
  assert.equal(new Set(results.map(({ applicationHash }) => applicationHash)).size, 1);
  assert.deepEqual(
    fs.readdirSync(path.join(cache, 'applications')),
    [results[0].applicationHash],
  );
  const verified = readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache });
  assert.equal(verified.applicationHash, results[0].applicationHash);
  assert.equal(path.dirname(verified.manifestPath), verified.applicationRoot);
  assert.equal(fs.statSync(verified.manifestPath).nlink, 1);
  assert.equal(fs.existsSync(path.join(cache, 'manifests')), false);
  assert.equal(fs.readFileSync(path.join(verified.applicationRoot, 'workers', 'nested', '39.txt'), 'utf8'), 'file-39');
  assert.equal(
    fs.readdirSync(path.join(verified.applicationRoot, 'workers', 'nested')).length,
    40,
  );
});

