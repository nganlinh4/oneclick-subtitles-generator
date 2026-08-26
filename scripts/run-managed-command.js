#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runSupervisedSync } = require('./windows-job-supervisor');
const { tauriFrontendDistOverride } = require('./managed-build-context.js');

const CACHE_SCHEMA_VERSION = 1;
const MANAGED_LANES = new Set(['dev', 'package']);
const LEASE_PATTERN = /^[0-9a-f]{32}$/u;

const isWindowsNamespacePath = (value) => {
  const windows = String(value).replaceAll('/', '\\');
  return windows.startsWith('\\\\?\\')
    || windows.startsWith('\\\\.\\')
    || windows.startsWith('\\??\\')
    || windows.startsWith('\\\\??\\')
    || windows.startsWith('\\Device\\')
    || windows.startsWith('\\GLOBAL??\\');
};

const hasAmbiguousSegment = (value) => String(value).split(/[\\/]+/u)
  .some((segment) => segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' '));

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

const parseArguments = (arguments_) => {
  if (arguments_[0] !== '--lane' || !MANAGED_LANES.has(arguments_[1])) {
    throw new Error('managed command requires --lane dev|package');
  }
  if (arguments_[2] !== '--' || typeof arguments_[3] !== 'string' || arguments_[3].length === 0) {
    throw new Error('managed command requires -- followed by a command');
  }
  return Object.freeze({
    lane: arguments_[1],
    command: arguments_[3],
    args: Object.freeze(arguments_.slice(4)),
  });
};

const cacheRootArguments = (cacheRoot) => (
  cacheRoot === undefined || cacheRoot === '' ? [] : ['-CacheRoot', cacheRoot]
);

const runChild = ({
  command, args, cwd, env, capture, spawn, supervise = runSupervisedSync, ownerProcessId,
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
    const error = new Error(`${path.basename(command)} exited with ${result.status}${detail}`);
    error.exitCode = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
    throw error;
  }
  return result;
};

const runDirectChild = ({ command, args, cwd, env, capture, spawn }) => {
  const executable = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
  const result = spawn(executable, args, {
    cwd,
    env,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture && result.stderr ? `\n${String(result.stderr).trim()}` : '';
    const error = new Error(`${path.basename(executable)} exited with ${result.status}${detail}`);
    error.exitCode = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
    throw error;
  }
  return result;
};

const invokeCacheManager = ({ repositoryRoot, cacheRoot, args, capture, spawn }) => runDirectChild({
  command: 'pwsh',
  args: [
    '-NoProfile',
    '-NonInteractive',
    '-File', path.join(repositoryRoot, 'scripts', 'dev-cache.ps1'),
    ...args,
    ...cacheRootArguments(cacheRoot),
  ],
  cwd: repositoryRoot,
  env: process.env,
  capture,
  spawn,
});

const parseLeaseContract = ({ stdout, lane, repositoryRoot }) => {
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
    || contract.lane !== lane
    || !LEASE_PATTERN.test(contract.rootId ?? '')
    || !LEASE_PATTERN.test(contract.leaseId ?? '')
    || !Number.isSafeInteger(contract.leaseProcessId)
    || contract.leaseProcessId < 1
    || typeof contract.leaseProcessCreatedUtc !== 'string'
    || Number.isNaN(Date.parse(contract.leaseProcessCreatedUtc))
  ) {
    throw new Error('managed cache lease returned an invalid identity contract');
  }
  for (const field of ['cacheRoot', 'cargoTargetDir', 'frontendCacheRoot', 'appPublicationRoot']) {
    const value = contract[field];
    if (
      typeof value !== 'string'
      || value.length === 0
      || !path.isAbsolute(value)
      || isWindowsNamespacePath(value)
      || hasAmbiguousSegment(value)
    ) {
      throw new Error(`managed cache lease returned an invalid ${field}`);
    }
  }
  const root = path.resolve(contract.cacheRoot);
  const repository = path.resolve(repositoryRoot);
  const cargoTarget = path.resolve(contract.cargoTargetDir);
  const frontendRoot = path.resolve(contract.frontendCacheRoot);
  const applicationRoot = path.resolve(contract.appPublicationRoot);
  if (samePath(root, repository) || isWithin(root, repository) || isWithin(repository, root)) {
    throw new Error('managed cache lease overlaps the repository');
  }
  if (
    !isWithin(root, cargoTarget)
    || !isWithin(root, frontendRoot)
    || !isWithin(root, applicationRoot)
    || samePath(cargoTarget, frontendRoot)
    || samePath(cargoTarget, applicationRoot)
    || samePath(frontendRoot, applicationRoot)
  ) {
    throw new Error('managed build output escaped or aliased inside its cache root');
  }
  const expectedLeasePaths = [cargoTarget, frontendRoot, applicationRoot]
    .map((directory) => path.join(directory, '.osg-cache-lease'));
  if (
    !Array.isArray(contract.leasePaths)
    || !expectedLeasePaths.every((expectedLeasePath) => contract.leasePaths.some((reported) => (
      typeof reported === 'string'
        && path.isAbsolute(reported)
        && !isWindowsNamespacePath(reported)
        && !hasAmbiguousSegment(reported)
        && samePath(reported, expectedLeasePath)
    )))
  ) {
    throw new Error('managed build outputs are not covered by the acquired group lease');
  }
  return Object.freeze(contract);
};

const prune = ({ repositoryRoot, cacheRoot, lane, protectLane = false, spawn }) => invokeCacheManager({
  repositoryRoot,
  cacheRoot,
  args: [
    '-Action', 'Prune',
    ...(protectLane ? ['-ProtectLane', lane] : []),
    '-ProtectUnit', 'apps-e2e',
    '-Apply',
    '-Confirm:$false',
  ],
  capture: false,
  spawn,
});

const acquire = ({ repositoryRoot, cacheRoot, lane, processId, spawn }) => {
  const result = invokeCacheManager({
    repositoryRoot,
    cacheRoot,
    args: [
      '-Action', 'Lease',
      '-LeaseOperation', 'Acquire',
      '-Lane', lane,
      '-LeaseProcessId', String(processId),
    ],
    capture: true,
    spawn,
  });
  return parseLeaseContract({ stdout: result.stdout, lane, repositoryRoot });
};

const release = ({ repositoryRoot, cacheRoot, lane, leaseId, spawn }) => invokeCacheManager({
  repositoryRoot,
  cacheRoot,
  args: [
    '-Action', 'Lease',
    '-LeaseOperation', 'Release',
    '-Lane', lane,
    '-LeaseId', leaseId,
  ],
  capture: true,
  spawn,
});

const runManagedCommand = ({
  arguments_: commandLine = process.argv.slice(2),
  repositoryRoot = path.resolve(__dirname, '..'),
  environment = process.env,
  processId = process.pid,
  spawn = spawnSync,
  supervise = runSupervisedSync,
} = {}) => {
  const invocation = parseArguments(commandLine);
  const repository = path.resolve(repositoryRoot);
  const cacheRoot = environment.OSG_DEV_CACHE_ROOT;
  let lease;
  let value;
  let primaryError;
  const cleanupErrors = [];

  try {
    // Let an over-cap or inactive copy of this lane be reclaimed before we claim it. Existing
    // processes remain protected by their lease and the manager's authoritative process scan.
    prune({ repositoryRoot: repository, cacheRoot, lane: invocation.lane, spawn });
    lease = acquire({
      repositoryRoot: repository,
      cacheRoot,
      lane: invocation.lane,
      processId,
      spawn,
    });
    // The relative frontendDist override is a directory, and `tauri::generate_context!` requires
    // it to exist at compile time. Real application builds populate it first (their frontend gates
    // enforce that); pure Rust check/test/clippy work may run before any frontend exists, so an
    // empty leased directory keeps codegen honest without faking a frontend.
    fs.mkdirSync(path.join(lease.frontendCacheRoot, 'build'), { recursive: true });
    value = runChild({
      command: invocation.command,
      args: invocation.args,
      cwd: repository,
      env: {
        ...environment,
        CARGO_TARGET_DIR: lease.cargoTargetDir,
        OSG_DEV_CACHE_ROOT: lease.cacheRoot,
        OSG_MANAGED_APPLICATION_ROOT: lease.appPublicationRoot,
        OSG_MANAGED_FRONTEND_ROOT: lease.frontendCacheRoot,
        OSG_MANAGED_LANE: invocation.lane,
        OSG_MANAGED_LEASE_ID: lease.leaseId,
        OSG_MANAGED_LEASE_PROCESS_CREATED_UTC: lease.leaseProcessCreatedUtc,
        OSG_MANAGED_LEASE_PROCESS_ID: String(lease.leaseProcessId),
        OSG_FRONTEND_OUT_DIR: path.join(lease.frontendCacheRoot, 'build'),
        OSG_PROMPTDJ_OUT_DIR: path.join(lease.frontendCacheRoot, 'promptdj'),
        OSG_VERSION_MODULE_PATH: path.join(lease.frontendCacheRoot, 'version.js'),
        TAURI_CONFIG: JSON.stringify({
          build: { frontendDist: tauriFrontendDistOverride(repository, path.join(lease.frontendCacheRoot, 'build')) },
        }),
      },
      capture: false,
      spawn,
      supervise,
      ownerProcessId: processId,
      managedPaths: [
        lease.cargoTargetDir,
        lease.frontendCacheRoot,
        lease.appPublicationRoot,
      ],
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (lease !== undefined) {
      try {
        release({
          repositoryRoot: repository,
          cacheRoot,
          lane: invocation.lane,
          leaseId: lease.leaseId,
          spawn,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      prune({
        repositoryRoot: repository,
        cacheRoot,
        lane: invocation.lane,
        protectLane: primaryError === undefined,
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
    throw new AggregateError(cleanupErrors, 'managed command completed but cache finalization failed');
  }
  return value;
};

if (require.main === module) {
  try {
    runManagedCommand();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    if (Array.isArray(error.cleanupErrors)) {
      for (const cleanup of error.cleanupErrors) {
        process.stderr.write(`cleanup: ${cleanup.stack || cleanup.message}\n`);
      }
    }
    process.exitCode = error.exitCode ?? 1;
  }
}

module.exports = {
  CACHE_SCHEMA_VERSION,
  MANAGED_LANES,
  acquire,
  hasAmbiguousSegment,
  invokeCacheManager,
  isWindowsNamespacePath,
  parseArguments,
  parseLeaseContract,
  prune,
  release,
  runChild,
  runDirectChild,
  runManagedCommand,
};
