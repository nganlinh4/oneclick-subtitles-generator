const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildE2eBinary,
  cargoArguments,
  isWindowsNamespacePath,
  parseCacheContract,
} = require('./build-e2e-binary');
const { tauriFrontendDistOverride } = require('./managed-build-context');

const leaseContract = ({ cacheRoot, leaseId = 'a'.repeat(32) }) => ({
  schemaVersion: 1,
  cacheRoot,
  rootId: 'b'.repeat(32),
  lane: 'e2e',
  primaryPath: path.join(cacheRoot, 'cargo', 'e2e'),
  cargoTargetDir: path.join(cacheRoot, 'cargo', 'e2e'),
  frontendCacheRoot: path.join(cacheRoot, 'frontend', 'e2e'),
  appPublicationRoot: path.join(cacheRoot, 'apps', 'e2e'),
  assetCacheRoot: path.join(cacheRoot, 'assets', 'e2e'),
  runtimeContentRoot: path.join(cacheRoot, 'runtime', 'sha256'),
  evidenceRoot: path.join(cacheRoot, 'evidence'),
  stagingRoot: path.join(cacheRoot, 'staging'),
  leasePaths: [
    path.join(cacheRoot, 'cargo', 'e2e', '.osg-cache-lease'),
    path.join(cacheRoot, 'frontend', 'e2e', '.osg-cache-lease'),
    path.join(cacheRoot, 'apps', 'e2e', '.osg-cache-lease'),
    path.join(cacheRoot, 'assets', 'e2e', '.osg-cache-lease'),
  ],
  leaseId,
});

const hasArguments = (args, ...expected) => expected.every((value) => args.includes(value));

test('the canonical builder leases external lanes and publishes only a verified immutable app', () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  const cacheRoot = path.join(os.tmpdir(), `osg-builder-contract-${process.pid}`);
  const contract = leaseContract({ cacheRoot });
  const snapshotRoot = path.join(contract.frontendCacheRoot, 'snapshots', 'c'.repeat(64));
  const receiptPath = path.join(contract.appPublicationRoot, 'receipts', 'current.json');
  const applicationHash = 'd'.repeat(64);
  const binaryPath = path.join(contract.appPublicationRoot, 'applications', applicationHash, 'osg-desktop.exe');
  const calls = [];
  let publishInput;
  let verifyInput;

  const result = buildE2eBinary({
    repositoryRoot,
    cacheRoot,
    processId: 4242,
    buildFrontend(input) {
      calls.push({ kind: 'frontend', input });
      return { snapshotRoot, snapshotHash: 'c'.repeat(64) };
    },
    publishApplication(input) {
      publishInput = input;
      calls.push({ kind: 'publish' });
      return { applicationHash, binaryPath, receiptPath };
    },
    verifyApplication(input) {
      verifyInput = input;
      calls.push({ kind: 'verify' });
      return { applicationHash, binaryPath, receiptPath };
    },
    spawn(command, args, options) {
      calls.push({ kind: command, args, options });
      if (command === 'pwsh' && hasArguments(args, 'Lease', 'Acquire')) {
        return { status: 0, stdout: `${JSON.stringify(contract)}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    supervise({ command, args, ...options }) {
      calls.push({ kind: command, args, options });
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  const powershell = calls.filter((call) => call.kind === 'pwsh');
  assert.equal(powershell.length, 4);
  assert.ok(hasArguments(powershell[0].args, 'Prune', '-Apply'));
  assert.equal(powershell[0].args.includes('-ProtectLane'), false);
  assert.ok(hasArguments(powershell[0].args, '-ProtectUnit', 'apps-e2e'));
  assert.ok(hasArguments(powershell[1].args, 'Lease', 'Acquire', '4242'));
  assert.ok(hasArguments(powershell[2].args, 'Lease', 'Release', contract.leaseId));
  assert.ok(hasArguments(powershell[3].args, 'Prune', '-Apply', '-ProtectLane', 'e2e'));
  assert.ok(hasArguments(powershell[3].args, '-ProtectUnit', 'apps-e2e'));
  for (const call of powershell) {
    assert.ok(hasArguments(call.args, '-CacheRoot', cacheRoot));
    assert.ok(hasArguments(call.args, '-NoProfile', '-NonInteractive'));
  }

  assert.deepEqual(calls.map((call) => call.kind), [
    'pwsh', 'pwsh', 'frontend', 'cargo', 'publish', 'verify', 'pwsh', 'pwsh',
  ]);
  const cargo = calls.find((call) => call.kind === 'cargo');
  assert.deepEqual(cargo.args, [...cargoArguments(contract.cargoTargetDir)]);
  const distOverride = JSON.parse(cargo.options.env.TAURI_CONFIG).build.frontendDist;
  assert.equal(distOverride, tauriFrontendDistOverride(repositoryRoot, snapshotRoot));
  // Relative and never URL-shaped: an absolute Windows path would parse with a drive-letter
  // scheme, so Tauri would embed no assets and open a file:// directory listing.
  assert.equal(path.isAbsolute(distOverride), false);
  assert.doesNotMatch(distOverride.replaceAll('\\', '/'), /^[A-Za-z][A-Za-z0-9+.-]*:/u);
  assert.equal(
    path.resolve(repositoryRoot, 'apps', 'desktop', 'src-tauri', distOverride).toLowerCase(),
    path.resolve(snapshotRoot).toLowerCase(),
  );
  assert.equal(process.env.TAURI_CONFIG, undefined);
  assert.deepEqual(publishInput, {
    profileRoot: path.join(contract.cargoTargetDir, 'x86_64-pc-windows-msvc', 'e2e'),
    applicationsCacheRoot: contract.appPublicationRoot,
    retentionLeaseId: contract.leaseId,
  });
  assert.deepEqual(calls.find((call) => call.kind === 'frontend').input, {
    repositoryRoot,
    cacheRoot: contract.frontendCacheRoot,
    retentionLeaseId: contract.leaseId,
  });
  assert.deepEqual(verifyInput, {
    applicationsCacheRoot: contract.appPublicationRoot,
    receiptPath,
  });
  assert.equal(result.application.applicationHash, applicationHash);
  assert.equal(result.frontend.snapshotRoot, snapshotRoot);
  assert.equal(result.assetCacheRoot, contract.assetCacheRoot);
});

test('a failed build releases its exact lease, preserves the primary error, and does not protect debris', () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  const cacheRoot = path.join(os.tmpdir(), `osg-builder-failure-${process.pid}`);
  const contract = leaseContract({ cacheRoot, leaseId: 'e'.repeat(32) });
  const primary = new Error('frontend exploded');
  let pruneCount = 0;

  assert.throws(() => buildE2eBinary({
    repositoryRoot,
    cacheRoot,
    processId: 4343,
    buildFrontend() {
      throw primary;
    },
    spawn(command, args) {
      if (command === 'pwsh' && hasArguments(args, 'Lease', 'Acquire')) {
        return { status: 0, stdout: JSON.stringify(contract), stderr: '' };
      }
      if (command === 'pwsh' && hasArguments(args, 'Lease', 'Release')) {
        assert.ok(args.includes(contract.leaseId));
        return { status: 7, stdout: '', stderr: 'release failed' };
      }
      if (command === 'pwsh' && args.includes('Prune')) {
        pruneCount += 1;
        assert.equal(args.includes('-ProtectLane'), false);
        assert.ok(hasArguments(args, '-ProtectUnit', 'apps-e2e'));
        if (pruneCount === 2) return { status: 8, stdout: '', stderr: 'prune failed' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  }), (error) => {
    assert.equal(error, primary);
    assert.equal(error.cleanupErrors.length, 2);
    assert.match(error.cleanupErrors[0].message, /release failed/u);
    assert.match(error.cleanupErrors[1].message, /exited with 8/u);
    return true;
  });
});

test('cache JSON is treated as an untrusted path contract', () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  const cacheRoot = path.join(os.tmpdir(), `osg-builder-parse-${process.pid}`);
  const valid = leaseContract({ cacheRoot });
  const parse = (value, requestedCacheRoot = cacheRoot) => parseCacheContract({
    stdout: JSON.stringify(value),
    repositoryRoot,
    requestedCacheRoot,
  });

  assert.equal(parse(valid).cargoTargetDir, valid.cargoTargetDir);
  assert.throws(() => parse({ ...valid, leaseId: '../bad' }), /invalid identity/u);
  assert.throws(() => parse({ ...valid, lane: 'dev' }), /invalid identity/u);
  assert.throws(() => parse({ ...valid, leasePaths: valid.leasePaths.slice(0, 3) }), /coverage/u);
  assert.throws(() => parse({
    ...valid,
    frontendCacheRoot: path.join(cacheRoot, 'cargo', 'e2e', 'nested'),
  }), /distinct and non-overlapping/u);
  assert.throws(() => parse({
    ...valid,
    appPublicationRoot: path.join(os.tmpdir(), 'escaped-apps'),
  }), /escaped its cache root/u);
  assert.throws(() => parse(valid, path.join(os.tmpdir(), 'different-cache')), /did not honour/u);
  assert.throws(() => parse({
    ...valid,
    cacheRoot: repositoryRoot,
    cargoTargetDir: path.join(repositoryRoot, 'cargo'),
    frontendCacheRoot: path.join(repositoryRoot, 'frontend'),
    appPublicationRoot: path.join(repositoryRoot, 'apps'),
  }, repositoryRoot), /overlaps the repository/u);
  assert.throws(() => parseCacheContract({
    stdout: 'manager warning\n{}',
    repositoryRoot,
    requestedCacheRoot: cacheRoot,
  }), /one valid JSON/u);

  assert.equal(isWindowsNamespacePath('\\\\?\\C:\\cache'), true);
  assert.equal(isWindowsNamespacePath('\\\\?\\UNC\\server\\cache'), true);
  assert.equal(isWindowsNamespacePath('\\\\.\\C:\\cache'), true);
  assert.equal(isWindowsNamespacePath('\\??\\C:\\cache'), true);
  assert.equal(isWindowsNamespacePath('C:\\cache'), false);
  assert.throws(() => parse({
    ...valid,
    cacheRoot: '\\\\?\\C:\\cache',
    cargoTargetDir: '\\\\?\\C:\\cache\\cargo\\e2e',
    frontendCacheRoot: '\\\\?\\C:\\cache\\frontend\\e2e',
    appPublicationRoot: '\\\\?\\C:\\cache\\apps\\e2e',
    assetCacheRoot: '\\\\?\\C:\\cache\\assets\\e2e',
  }, undefined), /invalid cacheRoot/u);
});
