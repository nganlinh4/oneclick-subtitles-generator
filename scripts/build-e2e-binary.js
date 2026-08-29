#!/usr/bin/env node

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runSupervisedSync } = require('./windows-job-supervisor');
const { tauriFrontendDistOverride } = require('./managed-build-context.js');
const { readCleanGitSourceProvenance } = require('./git-source-provenance.js');

const { buildE2eFrontendSnapshot } = require('./build-e2e-frontend');
const {
  publishE2eApplication,
  readAndVerifyE2eApplicationReceipt,
} = require('./e2e-application-publication');

const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const CARGO_PROFILE = 'e2e';
const CACHE_SCHEMA_VERSION = 1;
const LEASE_PATTERN = /^[0-9a-f]{32}$/u;

const isWindowsNamespacePath = (value) => {
  const windows = String(value).replaceAll('/', '\\');
  return windows.startsWith('\\\\?\\')
    || windows.startsWith('\\\\.\\')
    || windows.startsWith('\\??\\')
    || windows.startsWith('\\\\??\\');
};

const CARGO_ARGUMENT_PREFIX = Object.freeze([
  'build',
  '-p', 'osg-desktop',
  '--bin', 'osg-desktop',
  '--profile', CARGO_PROFILE,
  '--features', 'e2e-automation',
  '--target', TARGET_TRIPLE,
]);

const samePath = (left, right) => (
  process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right)
);

const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
};

const cargoArguments = (cargoTargetDir) => Object.freeze([
  ...CARGO_ARGUMENT_PREFIX,
  '--target-dir', cargoTargetDir,
  '--jobs', '1',
  '--locked',
]);

const formatInvocation = (command, args) => `${path.basename(command)} ${args.join(' ')}`;

const runChild = ({
  command,
  args,
  cwd,
  env = process.env,
  capture = false,
  spawn = spawnSync,
  supervise = runSupervisedSync,
  ownerProcessId = process.pid,
  managedPaths,
}) => {
  const result = supervise({
    command,
    args,
    cwd,
    env,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ownerProcessId,
    managedPaths,
    spawn,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture && result.stderr ? `\n${String(result.stderr).trim()}` : '';
    throw new Error(`${formatInvocation(command, args)} exited with ${result.status}${detail}`);
  }
  return result;
};

const runDirectChild = ({
  command, args, cwd, env = process.env, capture = false, spawn = spawnSync,
}) => {
  const result = spawn(command, args, {
    cwd,
    env,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture && result.stderr ? `\n${String(result.stderr).trim()}` : '';
    throw new Error(`${formatInvocation(command, args)} exited with ${result.status}${detail}`);
  }
  return result;
};

const sameSourceProvenance = (left, right) => (
  left.commit === right.commit && left.tree === right.tree && left.dirty === right.dirty
);

const cacheRootArguments = (cacheRoot) => (
  cacheRoot === undefined || cacheRoot === '' ? [] : ['-CacheRoot', cacheRoot]
);

const invokeCacheManager = ({
  repositoryRoot,
  args,
  cacheRoot,
  capture = false,
  spawn,
}) => runDirectChild({
  command: 'pwsh',
  args: [
    '-NoProfile',
    '-NonInteractive',
    '-File', path.join(repositoryRoot, 'scripts', 'dev-cache.ps1'),
    ...args,
    ...cacheRootArguments(cacheRoot),
  ],
  cwd: repositoryRoot,
  capture,
  spawn,
});

const parseCacheContract = ({ stdout, repositoryRoot, requestedCacheRoot }) => {
  let contract;
  try {
    contract = JSON.parse(String(stdout).trim());
  } catch (error) {
    throw new Error('managed cache lease did not return one valid JSON contract', { cause: error });
  }
  if (
    contract === null
    || typeof contract !== 'object'
    || contract.schemaVersion !== CACHE_SCHEMA_VERSION
    || contract.lane !== 'e2e'
    || !/^[0-9a-f]{32}$/u.test(contract.rootId ?? '')
    || !LEASE_PATTERN.test(contract.leaseId ?? '')
  ) {
    throw new Error('managed cache lease returned an invalid identity contract');
  }
  const requiredPaths = [
    'cacheRoot',
    'cargoTargetDir',
    'frontendCacheRoot',
    'appPublicationRoot',
    'assetCacheRoot',
  ];
  for (const field of requiredPaths) {
    const value = contract[field];
    if (
      typeof value !== 'string'
      || value.length === 0
      || isWindowsNamespacePath(value)
      || !path.isAbsolute(value)
      || value.split(/[\\/]+/u).some((part) => part === '.' || part === '..')
    ) {
      throw new Error(`managed cache lease returned an invalid ${field}`);
    }
  }
  const root = path.resolve(contract.cacheRoot);
  if (samePath(root, repositoryRoot) || isWithin(root, repositoryRoot) || isWithin(repositoryRoot, root)) {
    throw new Error('managed cache lease overlaps the repository');
  }
  for (const field of requiredPaths.slice(1)) {
    if (!isWithin(root, contract[field])) {
      throw new Error(`managed cache ${field} escaped its cache root`);
    }
  }
  if (requestedCacheRoot !== undefined && requestedCacheRoot !== '') {
    if (
      isWindowsNamespacePath(requestedCacheRoot)
      || !path.isAbsolute(requestedCacheRoot)
      || !samePath(root, requestedCacheRoot)
    ) {
      throw new Error('managed cache lease did not honour OSG_DEV_CACHE_ROOT');
    }
  }
  const lanePaths = requiredPaths.slice(1).map((field) => path.resolve(contract[field]));
  for (let left = 0; left < lanePaths.length; left += 1) {
    for (let right = left + 1; right < lanePaths.length; right += 1) {
      if (
        samePath(lanePaths[left], lanePaths[right])
        || isWithin(lanePaths[left], lanePaths[right])
        || isWithin(lanePaths[right], lanePaths[left])
      ) {
        throw new Error('managed E2E cache lanes must be distinct and non-overlapping');
      }
    }
  }
  const expectedLeasePaths = lanePaths.map((lanePath) => path.join(lanePath, '.osg-cache-lease'));
  if (
    !Array.isArray(contract.leasePaths)
    || contract.leasePaths.length !== expectedLeasePaths.length
    || expectedLeasePaths.some((expected) => (
      !contract.leasePaths.some((reported) => (
        typeof reported === 'string'
        && !isWindowsNamespacePath(reported)
        && path.isAbsolute(reported)
        && samePath(reported, expected)
      ))
    ))
  ) {
    throw new Error('managed E2E cache lease coverage is incomplete or ambiguous');
  }
  return Object.freeze(contract);
};

const pruneManagedCache = ({ repositoryRoot, cacheRoot, protectE2e, protectApplication, spawn }) => {
  const args = ['-Action', 'Prune', '-Apply', '-Confirm:$false'];
  if (protectE2e) args.push('-ProtectLane', 'e2e');
  if (protectApplication) args.push('-ProtectUnit', 'apps-e2e');
  invokeCacheManager({ repositoryRoot, args, cacheRoot, spawn });
};

const acquireE2eLease = ({ repositoryRoot, cacheRoot, processId, spawn }) => {
  const result = invokeCacheManager({
    repositoryRoot,
    args: [
      '-Action', 'Lease',
      '-LeaseOperation', 'Acquire',
      '-Lane', 'e2e',
      '-LeaseProcessId', String(processId),
    ],
    cacheRoot,
    capture: true,
    spawn,
  });
  return parseCacheContract({
    stdout: result.stdout,
    repositoryRoot,
    requestedCacheRoot: cacheRoot,
  });
};

const releaseE2eLease = ({ repositoryRoot, cacheRoot, leaseId, spawn }) => {
  invokeCacheManager({
    repositoryRoot,
    args: [
      '-Action', 'Lease',
      '-LeaseOperation', 'Release',
      '-Lane', 'e2e',
      '-LeaseId', leaseId,
    ],
    cacheRoot,
    capture: true,
    spawn,
  });
};

const buildE2eBinary = ({
  repositoryRoot = path.resolve(__dirname, '..'),
  cacheRoot = process.env.OSG_DEV_CACHE_ROOT,
  processId = process.pid,
  buildFrontend = buildE2eFrontendSnapshot,
  publishApplication = publishE2eApplication,
  verifyApplication = readAndVerifyE2eApplicationReceipt,
  spawn = spawnSync,
  supervise = runSupervisedSync,
  readSourceProvenance = readCleanGitSourceProvenance,
} = {}) => {
  const repository = path.resolve(repositoryRoot);
  let lease;
  let value;
  let primaryError;
  const cleanupErrors = [];

  try {
    const sourceProvenance = readSourceProvenance({ repositoryRoot: repository });
    // Reclaim only manager-owned external lanes before taking the build lease. Existing repository
    // targets are intentionally outside this boundary and can only be removed manually.
    pruneManagedCache({
      repositoryRoot: repository,
      cacheRoot,
      protectE2e: false,
      protectApplication: true,
      spawn,
    });
    lease = acquireE2eLease({
      repositoryRoot: repository,
      cacheRoot,
      processId,
      spawn,
    });
    const frontend = buildFrontend({
      repositoryRoot: repository,
      cacheRoot: lease.frontendCacheRoot,
      retentionLeaseId: lease.leaseId,
    });
    const tauriOverride = JSON.stringify({
      build: { frontendDist: tauriFrontendDistOverride(repository, frontend.snapshotRoot) },
    });
    const cargoArgs = cargoArguments(lease.cargoTargetDir);
    runChild({
      command: 'cargo',
      args: cargoArgs,
      cwd: repository,
      env: { ...process.env, TAURI_CONFIG: tauriOverride },
      spawn,
      supervise,
      ownerProcessId: processId,
      managedPaths: [
        lease.cargoTargetDir,
        lease.frontendCacheRoot,
        lease.appPublicationRoot,
        lease.assetCacheRoot,
      ],
    });
    const sourceAfterBuild = readSourceProvenance({ repositoryRoot: repository });
    if (!sameSourceProvenance(sourceProvenance, sourceAfterBuild)) {
      throw new Error('E2E application source revision changed while the binary was built');
    }
    const profileRoot = path.join(lease.cargoTargetDir, TARGET_TRIPLE, CARGO_PROFILE);
    const published = publishApplication({
      profileRoot,
      applicationsCacheRoot: lease.appPublicationRoot,
      retentionLeaseId: lease.leaseId,
      sourceProvenance,
    });
    const application = verifyApplication({
      applicationsCacheRoot: lease.appPublicationRoot,
      receiptPath: published.receiptPath,
    });
    if (
      application.applicationHash !== published.applicationHash
      || !samePath(application.binaryPath, published.binaryPath)
    ) {
      throw new Error('verified E2E application does not match the application just published');
    }
    value = Object.freeze({
      cacheRoot: lease.cacheRoot,
      cargoTargetDir: lease.cargoTargetDir,
      assetCacheRoot: lease.assetCacheRoot,
      frontend,
      tauriOverride,
      application,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (lease !== undefined) {
      try {
        releaseE2eLease({
          repositoryRoot: repository,
          cacheRoot,
          leaseId: lease.leaseId,
          spawn,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      // A successful publication stays protected. If that lane alone exceeds the cap, fail loudly
      // and leave its bytes intact instead of deleting the app the harness was just told to run.
      pruneManagedCache({
        repositoryRoot: repository,
        cacheRoot,
        protectE2e: primaryError === undefined,
        protectApplication: true,
        spawn,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) primaryError.cleanupErrors = cleanupErrors;
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'E2E build completed but cache finalization failed');
  }
  return value;
};

if (require.main === module) {
  try {
    const result = buildE2eBinary();
    process.stdout.write(
      `E2E application ${result.application.applicationHash}\n${result.application.binaryPath}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    if (Array.isArray(error.cleanupErrors)) {
      for (const cleanup of error.cleanupErrors) {
        process.stderr.write(`cleanup: ${cleanup.stack || cleanup.message}\n`);
      }
    }
    process.exitCode = 1;
  }
}

module.exports = {
  CACHE_SCHEMA_VERSION,
  CARGO_ARGUMENT_PREFIX,
  CARGO_PROFILE,
  TARGET_TRIPLE,
  acquireE2eLease,
  buildE2eBinary,
  cargoArguments,
  isWindowsNamespacePath,
  parseCacheContract,
  pruneManagedCache,
  releaseE2eLease,
  readCleanGitSourceProvenance,
  runChild,
};
