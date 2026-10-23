import { createRequire } from 'node:module';

import { withE2eApplicationLease } from './applicationLease.js';
import { withEvidenceLease } from './evidenceLease.js';
import {
  DEVELOPMENT_CACHE_ROOT, REPOSITORY_ROOT,
} from './environment.js';
import { withStagingLease } from './stagingLease.js';

const require = createRequire(import.meta.url);
const { pruneManagedCache } = require('../../scripts/build-e2e-binary.js');

const pruneE2eRuntimeCache = ({
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

// A full prune walks every lane, and the shared engine package alone is ~41k files, so one scan
// costs ~20 s. Pruning after every journey made that the largest fixed cost of a sweep; the
// managed-command wrapper already settles for once per interval, and so does this batch.
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Coordinate repeated journey lease sets without rescanning the complete cache after each one.
 *
 * The first prune happens only after the application/E2E-group lease is live, preserving the
 * existing protection of cargo/frontend/application/assets during preflight. Every operation then
 * releases evidence, staging, and application in the ordinary nested order. A failed operation is
 * always followed by a post-prune; a passing one prunes only once the interval has elapsed, and
 * `flush()` runs any prune that was deferred, after the last journey.
 */
export const createE2eCacheMaintenanceBatch = ({
  prune = pruneE2eRuntimeCache,
  withApplicationLease = withE2eApplicationLease,
  withEvidence = withEvidenceLease,
  withStaging = withStagingLease,
  now = Date.now,
} = {}) => {
  let preflightComplete = false;
  let lastPruneAt = null;
  let deferred = false;
  const pruneNow = () => {
    deferred = false;
    prune();
    lastPruneAt = now();
  };
  return Object.freeze({
    withLeases: (operation) => {
      if (typeof operation !== 'function') {
        throw new TypeError('E2E cache maintenance requires a lease operation');
      }
      let applicationAcquired = false;
      let failed = true;
      const run = () => withApplicationLease((applicationLease) => {
        applicationAcquired = true;
        if (!preflightComplete) {
          pruneNow();
          preflightComplete = true;
        }
        return withStaging((stagingLease) => withEvidence((evidenceLease) => {
          const value = operation({ applicationLease, evidenceLease, stagingLease });
          if (value !== null && typeof value === 'object' && typeof value.then === 'function') {
            throw new TypeError('E2E lease operations must be synchronous');
          }
          failed = false;
          return value;
        }, { cacheMaintenance: 'external' }), { cacheMaintenance: 'external' });
      }, { cacheMaintenance: 'external' });

      return settleWithPostPrune({
        operation: run,
        prune: () => {
          if (!applicationAcquired) return;
          if (failed || lastPruneAt === null || now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
            pruneNow();
          } else {
            deferred = true;
          }
        },
      });
    },
    flush: () => {
      if (deferred) pruneNow();
    },
  });
};

export { settleWithPostPrune };
