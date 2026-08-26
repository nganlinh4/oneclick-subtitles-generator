import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import {
  DEVELOPMENT_CACHE_ROOT, EVIDENCE_CACHE_ROOT, REPOSITORY_ROOT,
} from './environment.js';

const CACHE_SCHEMA_VERSION = 1;
const ID_PATTERN = /^[0-9a-f]{32}$/u;
const WINDOWS_NAMESPACE_PREFIXES = Object.freeze([
  '\\\\?\\', '\\\\.\\', '\\??\\', '\\\\??\\',
  '\\device\\', '\\\\device\\', '\\global??\\', '\\\\global??\\',
]);

const isWindowsNamespace = (value) => {
  const windowsPath = String(value).replaceAll('/', '\\').toLowerCase();
  return WINDOWS_NAMESPACE_PREFIXES.some((prefix) => windowsPath.startsWith(prefix));
};

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

const runManager = ({
  arguments: managerArguments,
  cacheRoot,
  repositoryRoot,
  capture = false,
  spawn,
}) => {
  const result = spawn(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File', join(repositoryRoot, 'scripts', 'dev-cache.ps1'),
      ...managerArguments,
      '-CacheRoot', cacheRoot,
    ],
    {
      cwd: repositoryRoot,
      encoding: capture ? 'utf8' : undefined,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture && result.stderr ? `\n${String(result.stderr).trim()}` : '';
    throw new Error(`managed evidence cache command exited with ${result.status}${detail}`);
  }
  return result;
};

export const parseEvidenceLeaseContract = ({
  stdout,
  cacheRoot = DEVELOPMENT_CACHE_ROOT,
  evidenceRoot = EVIDENCE_CACHE_ROOT,
  repositoryRoot = REPOSITORY_ROOT,
} = {}) => {
  let contract;
  try {
    contract = JSON.parse(String(stdout).trim());
  } catch (error) {
    throw new Error('managed evidence lease did not return one valid JSON contract', {
      cause: error,
    });
  }
  if (
    contract === null
    || typeof contract !== 'object'
    || contract.schemaVersion !== CACHE_SCHEMA_VERSION
    || contract.lane !== 'evidence'
    || !ID_PATTERN.test(contract.rootId ?? '')
    || !ID_PATTERN.test(contract.leaseId ?? '')
    || contract.leaseProcessId !== process.pid
  ) {
    throw new Error('managed evidence lease returned an invalid identity contract');
  }
  for (const [label, value] of [
    ['cacheRoot', contract.cacheRoot],
    ['evidenceRoot', contract.evidenceRoot],
    ['primaryPath', contract.primaryPath],
  ]) {
    if (
      typeof value !== 'string'
      || !isAbsolute(value)
      || isWindowsNamespace(value)
      || value.split(/[\\/]+/u).some((segment) => segment === '.' || segment === '..')
      || value.split(/[\\/]+/u).some((segment) => segment.length > 0 && /[. ]$/u.test(segment))
    ) {
      throw new Error(`managed evidence lease returned an invalid ${label}`);
    }
  }
  if (
    !samePath(contract.cacheRoot, cacheRoot)
    || !samePath(contract.evidenceRoot, evidenceRoot)
    || !samePath(contract.primaryPath, evidenceRoot)
    || !isStrictChild(evidenceRoot, cacheRoot)
    || samePath(cacheRoot, repositoryRoot)
    || isStrictChild(cacheRoot, repositoryRoot)
    || isStrictChild(repositoryRoot, cacheRoot)
  ) {
    throw new Error('managed evidence lease selected an unexpected cache boundary');
  }
  const expectedLeasePath = join(evidenceRoot, '.osg-cache-lease');
  if (
    !Array.isArray(contract.leasePaths)
    || contract.leasePaths.length !== 1
    || typeof contract.leasePaths[0] !== 'string'
    || !samePath(contract.leasePaths[0], expectedLeasePath)
  ) {
    throw new Error('managed evidence lease does not cover the exact evidence lane');
  }
  return Object.freeze(contract);
};

/** Hold the manager-owned evidence lane for one complete workflow attempt. */
export const acquireEvidenceLease = ({
  cacheRoot = DEVELOPMENT_CACHE_ROOT,
  evidenceRoot = EVIDENCE_CACHE_ROOT,
  processId = process.pid,
  repositoryRoot = REPOSITORY_ROOT,
  spawn = spawnSync,
} = {}) => {
  // Converge debris from a prior hard-killed owner before creating another running attempt. An
  // active lease/process scan still protects live bytes; the immutable app remains independently
  // protected because an evidence run must never invalidate the next launch receipt.
  runManager({
    arguments: [
      '-Action', 'Prune', '-Apply', '-Confirm:$false', '-ProtectUnit', 'apps-e2e',
    ],
    cacheRoot,
    repositoryRoot,
    spawn,
  });
  const acquired = runManager({
    arguments: [
      '-Action', 'Lease',
      '-LeaseOperation', 'Acquire',
      '-Lane', 'evidence',
      '-LeaseProcessId', String(processId),
    ],
    cacheRoot,
    repositoryRoot,
    capture: true,
    spawn,
  });
  // An invalid response may still describe a lease the manager actually created. Do not guess at
  // an untrusted id to release it: the real owner PID makes it stale as soon as this process exits.
  const contract = parseEvidenceLeaseContract({
    stdout: acquired.stdout,
    cacheRoot,
    evidenceRoot,
    repositoryRoot,
  });
  let released = false;
  return Object.freeze({
    leaseId: contract.leaseId,
    evidenceRoot: contract.evidenceRoot,
    release: () => {
      if (released) return false;
      runManager({
        arguments: [
          '-Action', 'Lease',
          '-LeaseOperation', 'Release',
          '-Lane', 'evidence',
          '-LeaseId', contract.leaseId,
        ],
        cacheRoot,
        repositoryRoot,
        capture: true,
        spawn,
      });
      released = true;
      // Evidence is a dedicated whole unit. Once the completed attempt is durable, let the manager
      // apply its ordinary age/cap policy. Protect only the current immutable application unit: a
      // completed evidence run must not invalidate receipts/current.json for the next journey.
      runManager({
        arguments: [
          '-Action', 'Prune', '-Apply', '-Confirm:$false', '-ProtectUnit', 'apps-e2e',
        ],
        cacheRoot,
        repositoryRoot,
        spawn,
      });
      return true;
    },
  });
};

export const withEvidenceLease = (operation, options) => {
  const lease = acquireEvidenceLease(options);
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
      throw new AggregateError(
        [primaryError, error],
        'the workflow evidence operation and its lease finalization both failed',
      );
    }
    throw error;
  }
  if (primaryError !== undefined) throw primaryError;
  return value;
};
