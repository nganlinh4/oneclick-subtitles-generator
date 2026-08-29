import { createRequire } from 'node:module';

import { withE2eApplicationLease } from './applicationLease.js';
import { withEvidenceLease } from './evidenceLease.js';
import {
  DEVELOPMENT_CACHE_ROOT, REPOSITORY_ROOT,
} from './environment.js';
import { withStagingLease } from './stagingLease.js';

const require = createRequire(import.meta.url);
const { pruneManagedCache } = require('../../scripts/build-e2e-binary.js');

export const pruneE2eRuntimeCache = ({
  cacheRoot = DEVELOPMENT_CACHE_ROOT,
  prune = pruneManagedCache,
  repositoryRoot = REPOSITORY_ROOT,
} = {}) => prune({
  repositoryRoot,
  cacheRoot,
  protectE2e: false,
  protectApplication: true,
});

const settleWithPostPrune = ({ operation, prune }) => {
  let value;
  let primaryError;
  try {
    value = operation();
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    prune();
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'the E2E lease operation and its post-journey cache prune both failed',
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  return value;
};

/**
 * Coordinate repeated journey lease sets without rescanning the complete cache five times each.
 *
 * The first prune happens only after the application/E2E-group lease is live, preserving the
 * existing protection of cargo/frontend/application/assets during preflight. Every operation then
 * releases evidence, staging, and application in the ordinary nested order before one post-prune.
 * That boundary prune is also the next operation's pre-prune, so N journeys perform N+1 scans.
 */
export const createE2eCacheMaintenanceBatch = ({
  prune = pruneE2eRuntimeCache,
  withApplicationLease = withE2eApplicationLease,
  withEvidence = withEvidenceLease,
  withStaging = withStagingLease,
} = {}) => {
  let preflightComplete = false;
  return Object.freeze({
    withLeases: (operation) => {
      if (typeof operation !== 'function') {
        throw new TypeError('E2E cache maintenance requires a lease operation');
      }
      let applicationAcquired = false;
      const run = () => withApplicationLease((applicationLease) => {
        applicationAcquired = true;
        if (!preflightComplete) {
          prune();
          preflightComplete = true;
        }
        return withStaging((stagingLease) => withEvidence((evidenceLease) => operation({
          applicationLease,
          evidenceLease,
          stagingLease,
        }), { cacheMaintenance: 'external' }), { cacheMaintenance: 'external' });
      }, { cacheMaintenance: 'external' });

      return settleWithPostPrune({
        operation: run,
        prune: () => {
          if (applicationAcquired) prune();
        },
      });
    },
  });
};

export { settleWithPostPrune };
