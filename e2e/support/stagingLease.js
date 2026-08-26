import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import {
  DEVELOPMENT_CACHE_ROOT, E2E_STAGING_ROOT, REPOSITORY_ROOT,
} from './environment.js';

const ID_PATTERN = /^[0-9a-f]{32}$/u;

const samePath = (left, right) => (
  process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
);

const isStrictChild = (candidate, parent) => {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  return pathFromParent !== ''
    && pathFromParent !== '..'
    && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent);
};

const manager = ({ arguments: arguments_, cacheRoot, repositoryRoot, capture, spawn }) => {
  const result = spawn('pwsh', [
    '-NoProfile', '-NonInteractive',
    '-File', join(repositoryRoot, 'scripts', 'dev-cache.ps1'),
    ...arguments_,
    '-CacheRoot', cacheRoot,
  ], {
    cwd: repositoryRoot,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture && result.stderr ? `\n${String(result.stderr).trim()}` : '';
    throw new Error(`managed staging cache command exited with ${result.status}${detail}`);
  }
  return result;
};

export const parseStagingLeaseContract = ({
  stdout,
  cacheRoot = DEVELOPMENT_CACHE_ROOT,
  stagingRoot = E2E_STAGING_ROOT,
  repositoryRoot = REPOSITORY_ROOT,
  processId = process.pid,
} = {}) => {
  let contract;
  try {
    contract = JSON.parse(String(stdout).trim());
  } catch (error) {
    throw new Error('managed staging lease did not return one valid JSON contract', { cause: error });
  }
  if (
    contract === null
    || typeof contract !== 'object'
    || contract.schemaVersion !== 1
    || contract.lane !== 'staging'
    || !ID_PATTERN.test(contract.rootId ?? '')
    || !ID_PATTERN.test(contract.leaseId ?? '')
    || contract.leaseProcessId !== processId
    || !samePath(contract.cacheRoot ?? '', cacheRoot)
    || !samePath(contract.primaryPath ?? '', stagingRoot)
    || !samePath(contract.stagingRoot ?? '', stagingRoot)
    || !isStrictChild(stagingRoot, cacheRoot)
    || !Array.isArray(contract.leasePaths)
    || contract.leasePaths.length !== 1
    || !samePath(contract.leasePaths[0] ?? '', join(stagingRoot, '.osg-cache-lease'))
    || samePath(cacheRoot, repositoryRoot)
    || isStrictChild(cacheRoot, repositoryRoot)
    || isStrictChild(repositoryRoot, cacheRoot)
  ) {
    throw new Error('managed staging lease returned an invalid cache boundary or identity');
  }
  return Object.freeze(contract);
};

export const acquireStagingLease = ({
  cacheRoot = DEVELOPMENT_CACHE_ROOT,
  stagingRoot = E2E_STAGING_ROOT,
  repositoryRoot = REPOSITORY_ROOT,
  processId = process.pid,
  spawn = spawnSync,
} = {}) => {
  manager({
    arguments: [
      '-Action', 'Prune', '-Apply', '-Confirm:$false', '-ProtectUnit', 'apps-e2e',
    ],
    cacheRoot,
    repositoryRoot,
    capture: false,
    spawn,
  });
  const acquired = manager({
    arguments: [
      '-Action', 'Lease', '-LeaseOperation', 'Acquire', '-Lane', 'staging',
      '-LeaseProcessId', String(processId),
    ],
    cacheRoot,
    repositoryRoot,
    capture: true,
    spawn,
  });
  const contract = parseStagingLeaseContract({
    stdout: acquired.stdout, cacheRoot, stagingRoot, repositoryRoot, processId,
  });
  let released = false;
  return Object.freeze({
    leaseId: contract.leaseId,
    leaseOwnerProcessCreatedUtc: contract.leaseProcessCreatedUtc,
    stagingRoot: contract.stagingRoot,
    managedPaths: Object.freeze([contract.stagingRoot]),
    release: () => {
      if (released) return false;
      manager({
        arguments: [
          '-Action', 'Lease', '-LeaseOperation', 'Release', '-Lane', 'staging',
          '-LeaseId', contract.leaseId,
        ],
        cacheRoot,
        repositoryRoot,
        capture: true,
        spawn,
      });
      released = true;
      manager({
        arguments: [
          '-Action', 'Prune', '-Apply', '-Confirm:$false', '-ProtectUnit', 'apps-e2e',
        ],
        cacheRoot,
        repositoryRoot,
        capture: false,
        spawn,
      });
      return true;
    },
  });
};

export const withStagingLease = (operation, options) => {
  const lease = acquireStagingLease(options);
  let value;
  let primaryError;
  try {
    value = operation(lease);
  } catch (error) {
    primaryError = error;
  }
  try {
    lease.release();
  } catch (error) {
    if (primaryError !== undefined) {
      throw new AggregateError([primaryError, error], 'staged work and staging lease cleanup failed');
    }
    throw error;
  }
  if (primaryError !== undefined) throw primaryError;
  return value;
};
