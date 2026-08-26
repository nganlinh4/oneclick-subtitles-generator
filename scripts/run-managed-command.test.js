const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  parseArguments,
  parseLeaseContract,
  runManagedCommand,
} = require('./run-managed-command');
const { tauriFrontendDistOverride } = require('./managed-build-context');

const repositoryRoot = path.resolve(__dirname, '..');
const cacheRoot = path.resolve(repositoryRoot, '..', 'managed-command-test-cache');
const cargoTargetDir = path.join(cacheRoot, 'cargo', 'dev');
const leaseId = '2'.repeat(32);

const contract = (lane = 'dev') => JSON.stringify({
  schemaVersion: 1,
  rootId: '1'.repeat(32),
  lane,
  cacheRoot,
  cargoTargetDir: path.join(cacheRoot, 'cargo', lane),
  frontendCacheRoot: path.join(cacheRoot, 'frontend', lane),
  appPublicationRoot: path.join(cacheRoot, 'apps', lane),
  assetCacheRoot: null,
  leaseId,
  leaseProcessId: 1234,
  leaseProcessCreatedUtc: '2026-08-26T00:00:00.0000000Z',
  leasePaths: [
    path.join(cacheRoot, 'cargo', lane, '.osg-cache-lease'),
    path.join(cacheRoot, 'frontend', lane, '.osg-cache-lease'),
    path.join(cacheRoot, 'apps', lane, '.osg-cache-lease'),
  ],
});

test('argument parser preserves the child command after the one structural delimiter', () => {
  assert.deepEqual(
    parseArguments(['--lane', 'package', '--', 'npm', '--prefix', 'apps/desktop', '--', '--no-bundle']),
    {
      lane: 'package',
      command: 'npm',
      args: ['--prefix', 'apps/desktop', '--', '--no-bundle'],
    },
  );
  assert.throws(() => parseArguments(['--lane', 'e2e', '--', 'cargo', 'check']), /dev\|package/);
  assert.throws(() => parseArguments(['--lane', 'dev', 'cargo', 'check']), /requires --/);
});

test('lease parser rejects repository overlap, namespace paths, and incomplete coverage', () => {
  assert.equal(parseLeaseContract({ stdout: contract(), lane: 'dev', repositoryRoot }).leaseId, leaseId);
  const overlapping = JSON.parse(contract());
  overlapping.cacheRoot = repositoryRoot;
  overlapping.cargoTargetDir = path.join(repositoryRoot, 'target');
  overlapping.leasePaths[0] = path.join(overlapping.cargoTargetDir, '.osg-cache-lease');
  assert.throws(
    () => parseLeaseContract({ stdout: JSON.stringify(overlapping), lane: 'dev', repositoryRoot }),
    /overlaps the repository/,
  );
  const namespace = JSON.parse(contract());
  namespace.cargoTargetDir = `\\\\?\\${cargoTargetDir}`;
  assert.throws(
    () => parseLeaseContract({ stdout: JSON.stringify(namespace), lane: 'dev', repositoryRoot }),
    /invalid cargoTargetDir/,
  );
  const uncovered = JSON.parse(contract());
  uncovered.leasePaths = uncovered.leasePaths.slice(1);
  assert.throws(
    () => parseLeaseContract({ stdout: JSON.stringify(uncovered), lane: 'dev', repositoryRoot }),
    /not covered/,
  );
});

test('managed command leases the external Cargo lane for the complete child lifetime', () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    if (command === 'pwsh' && args.includes('Acquire')) {
      return { status: 0, stdout: contract(), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const supervise = ({ command, args, ...options }) => spawn(command, args, options);
  runManagedCommand({
    arguments_: ['--lane', 'dev', '--', 'cargo', 'check', '--locked'],
    repositoryRoot,
    environment: { OSG_DEV_CACHE_ROOT: cacheRoot, KEEP_ME: 'yes', CARGO_TARGET_DIR: 'unsafe-old' },
    processId: 1234,
    spawn,
    supervise,
  });

  assert.equal(calls.length, 5);
  assert.ok(calls[0].args.includes('Prune'));
  assert.equal(calls[0].args.includes('-ProtectLane'), false);
  assert.ok(calls[0].args.includes('apps-e2e'));
  assert.ok(calls[1].args.includes('Acquire'));
  assert.equal(calls[2].command, 'cargo');
  assert.deepEqual(calls[2].args, ['check', '--locked']);
  assert.equal(calls[2].options.env.CARGO_TARGET_DIR, cargoTargetDir);
  assert.equal(calls[2].options.env.OSG_DEV_CACHE_ROOT, cacheRoot);
  assert.equal(calls[2].options.env.OSG_MANAGED_APPLICATION_ROOT, path.join(cacheRoot, 'apps', 'dev'));
  assert.equal(calls[2].options.env.OSG_MANAGED_LANE, 'dev');
  assert.equal(calls[2].options.env.OSG_MANAGED_LEASE_ID, leaseId);
  assert.equal(calls[2].options.env.OSG_MANAGED_LEASE_PROCESS_ID, '1234');
  assert.equal(
    calls[2].options.env.OSG_MANAGED_LEASE_PROCESS_CREATED_UTC,
    '2026-08-26T00:00:00.0000000Z',
  );
  assert.equal(
    calls[2].options.env.OSG_MANAGED_FRONTEND_ROOT,
    path.join(cacheRoot, 'frontend', 'dev'),
  );
  assert.equal(
    calls[2].options.env.OSG_FRONTEND_OUT_DIR,
    path.join(cacheRoot, 'frontend', 'dev', 'build'),
  );
  assert.equal(
    calls[2].options.env.OSG_PROMPTDJ_OUT_DIR,
    path.join(cacheRoot, 'frontend', 'dev', 'promptdj'),
  );
  assert.equal(
    calls[2].options.env.OSG_VERSION_MODULE_PATH,
    path.join(cacheRoot, 'frontend', 'dev', 'version.js'),
  );
  assert.deepEqual(JSON.parse(calls[2].options.env.TAURI_CONFIG), {
    build: {
      frontendDist: tauriFrontendDistOverride(
        repositoryRoot,
        path.join(cacheRoot, 'frontend', 'dev', 'build'),
      ),
    },
  });
  assert.equal(calls[2].options.env.KEEP_ME, 'yes');
  assert.ok(calls[3].args.includes('Release'));
  assert.ok(calls[4].args.includes('Prune'));
  assert.deepEqual(
    calls[4].args.slice(calls[4].args.indexOf('-ProtectLane'), calls[4].args.indexOf('-ProtectLane') + 2),
    ['-ProtectLane', 'dev'],
  );
});

test('child failure keeps its exit code and still releases and prunes', () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'pwsh' && args.includes('Acquire')) {
      return { status: 0, stdout: contract(), stderr: '' };
    }
    if (command === 'cargo') return { status: 7, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const supervise = ({ command, args, ...options }) => spawn(command, args, options);
  assert.throws(
    () => runManagedCommand({
      arguments_: ['--lane', 'dev', '--', 'cargo', 'test'],
      repositoryRoot,
      environment: { OSG_DEV_CACHE_ROOT: cacheRoot },
      processId: 1234,
      spawn,
      supervise,
    }),
    (error) => error.exitCode === 7,
  );
  assert.ok(calls.some(({ args }) => args.includes('Release')));
  const prunes = calls.filter(({ args }) => args.includes('Prune'));
  assert.equal(prunes.length, 2);
  assert.ok(prunes.every(({ args }) => !args.includes('-ProtectLane')));
});
