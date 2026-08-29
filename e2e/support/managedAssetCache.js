import { createRequire } from 'node:module';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import {
  isAbsolute, relative, resolve, sep,
} from 'node:path';
import process from 'node:process';

import { assertLiveE2eAssetLease } from './applicationLease.js';
import { E2E_ASSET_CACHE_ROOT, REPOSITORY_ROOT } from './environment.js';

const require = createRequire(import.meta.url);
const { runSupervisedSync } = require('../../scripts/windows-job-supervisor.js');
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
  : resolve(left) === resolve(right);

const prepareCacheChild = ({ assetRoot, cacheRoot }) => {
  const remainder = relative(assetRoot, resolve(cacheRoot));
  if (remainder === '' || remainder === '..' || remainder.startsWith(`..${sep}`) || remainder.includes(sep)) {
    throw new Error('managed fixture cache must be one direct child of the leased asset root');
  }
  mkdirSync(cacheRoot, { recursive: true });
  const metadata = lstatSync(cacheRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || !samePath(realpathSync.native(cacheRoot), cacheRoot)) {
    throw new Error('managed fixture cache root is redirected');
  }
  return cacheRoot;
};

export const prepareManagedAssetCache = ({ applicationLease, cacheRoot }) => {
  const assetRoot = assertLiveE2eAssetLease(applicationLease);
  return prepareCacheChild({ assetRoot, cacheRoot });
};

/** Safe filesystem seam for root-boundary tests; it cannot target the persistent E2E asset tree. */
export const prepareManagedAssetCacheForTest = ({ assetRoot, cacheRoot }) => {
  const candidate = resolve(assetRoot);
  const managedRelative = relative(resolve(E2E_ASSET_CACHE_ROOT), candidate);
  if (managedRelative === ''
      || (managedRelative !== '..'
        && !managedRelative.startsWith(`..${sep}`)
        && !isAbsolute(managedRelative))) {
    throw new Error('the managed-cache test seam refuses the persistent E2E asset tree');
  }
  return prepareCacheChild({ assetRoot: candidate, cacheRoot });
};

export const runSupervisedAssetTool = ({ applicationLease, command, args }) => {
  assertLiveE2eAssetLease(applicationLease);
  const result = runSupervisedSync({
    command,
    args,
    cwd: REPOSITORY_ROOT,
    env: process.env,
    stdio: 'inherit',
    ownerProcessId: process.pid,
    managedPaths: applicationLease.managedPaths,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`managed fixture tool failed with exit ${result.status}`);
  assertLiveE2eAssetLease(applicationLease);
};
