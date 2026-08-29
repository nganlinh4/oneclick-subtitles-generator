import assert from 'node:assert/strict';
import test from 'node:test';

import { createE2eCacheMaintenanceBatch } from './cacheMaintenance.js';

const leaseWrapper = (label, events, { acquireError, releaseError } = {}) => (
  operation, options,
) => {
  assert.deepEqual(options, { cacheMaintenance: 'external' });
  events.push(`${label}:acquire`);
  if (acquireError !== undefined) throw acquireError;
  let value;
  let primaryError;
  try {
    value = operation(Object.freeze({ label }));
  } catch (error) {
    primaryError = error;
  }
  events.push(`${label}:release`);
  if (primaryError !== undefined && releaseError !== undefined) {
    throw new AggregateError([primaryError, releaseError], `${label} operation and release failed`);
  }
  if (primaryError !== undefined) throw primaryError;
  if (releaseError !== undefined) throw releaseError;
  return value;
};

test('two operations perform N+1 prunes with preflight inside the first application lease', () => {
  const events = [];
  const batch = createE2eCacheMaintenanceBatch({
    prune: () => events.push('prune'),
    withApplicationLease: leaseWrapper('application', events),
    withEvidence: leaseWrapper('evidence', events),
    withStaging: leaseWrapper('staging', events),
  });

  assert.equal(batch.withLeases(() => {
    events.push('operation:1');
    return 41;
  }), 41);
  assert.equal(batch.withLeases(() => {
    events.push('operation:2');
    return 42;
  }), 42);

  assert.deepEqual(events, [
    'application:acquire',
    'prune',
    'staging:acquire',
    'evidence:acquire',
    'operation:1',
    'evidence:release',
    'staging:release',
    'application:release',
    'prune',
    'application:acquire',
    'staging:acquire',
    'evidence:acquire',
    'operation:2',
    'evidence:release',
    'staging:release',
    'application:release',
    'prune',
  ]);
});

test('operation and post-prune failures retain primary then cleanup error order', () => {
  const events = [];
  const primary = new Error('operation failed');
  const cleanup = new Error('post-prune failed');
  let prunes = 0;
  const batch = createE2eCacheMaintenanceBatch({
    prune: () => {
      events.push('prune');
      prunes += 1;
      if (prunes === 2) throw cleanup;
    },
    withApplicationLease: leaseWrapper('application', events),
    withEvidence: leaseWrapper('evidence', events),
    withStaging: leaseWrapper('staging', events),
  });

  assert.throws(
    () => batch.withLeases(() => {
      events.push('operation');
      throw primary;
    }),
    (error) => error instanceof AggregateError
      && error.errors[0] === primary
      && error.errors[1] === cleanup,
  );
  assert.deepEqual(events, [
    'application:acquire', 'prune', 'staging:acquire', 'evidence:acquire', 'operation',
    'evidence:release', 'staging:release', 'application:release', 'prune',
  ]);
});

test('every release unwinds in reverse order before post-prune and preserves failure order', () => {
  const events = [];
  const operationError = new Error('operation failed');
  const evidenceReleaseError = new Error('evidence release failed');
  const stagingReleaseError = new Error('staging release failed');
  const applicationReleaseError = new Error('application release failed');
  const postPruneError = new Error('post-prune failed');
  let prunes = 0;
  const batch = createE2eCacheMaintenanceBatch({
    prune: () => {
      events.push('prune');
      prunes += 1;
      if (prunes === 2) throw postPruneError;
    },
    withApplicationLease: leaseWrapper('application', events, {
      releaseError: applicationReleaseError,
    }),
    withEvidence: leaseWrapper('evidence', events, { releaseError: evidenceReleaseError }),
    withStaging: leaseWrapper('staging', events, { releaseError: stagingReleaseError }),
  });

  assert.throws(
    () => batch.withLeases(() => {
      events.push('operation');
      throw operationError;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[1], postPruneError);
      const applicationError = error.errors[0];
      assert.ok(applicationError instanceof AggregateError);
      assert.equal(applicationError.errors[1], applicationReleaseError);
      const stagingError = applicationError.errors[0];
      assert.ok(stagingError instanceof AggregateError);
      assert.equal(stagingError.errors[1], stagingReleaseError);
      const evidenceError = stagingError.errors[0];
      assert.ok(evidenceError instanceof AggregateError);
      assert.deepEqual(evidenceError.errors, [operationError, evidenceReleaseError]);
      return true;
    },
  );
  assert.deepEqual(events, [
    'application:acquire', 'prune', 'staging:acquire', 'evidence:acquire', 'operation',
    'evidence:release', 'staging:release', 'application:release', 'prune',
  ]);
});

test('a failed initial prune releases the application and still attempts post-prune', () => {
  const events = [];
  const initial = new Error('initial prune failed');
  const cleanup = new Error('cleanup prune failed');
  let prunes = 0;
  const batch = createE2eCacheMaintenanceBatch({
    prune: () => {
      events.push('prune');
      prunes += 1;
      throw prunes === 1 ? initial : cleanup;
    },
    withApplicationLease: leaseWrapper('application', events),
    withEvidence: leaseWrapper('evidence', events),
    withStaging: leaseWrapper('staging', events),
  });

  assert.throws(
    () => batch.withLeases(() => assert.fail('operation must not start')),
    (error) => error instanceof AggregateError
      && error.errors[0] === initial
      && error.errors[1] === cleanup,
  );
  assert.deepEqual(events, [
    'application:acquire', 'prune', 'application:release', 'prune',
  ]);
});

test('an application acquisition failure performs no unleased cache prune', () => {
  const events = [];
  const acquisition = new Error('application acquisition failed');
  const batch = createE2eCacheMaintenanceBatch({
    prune: () => events.push('prune'),
    withApplicationLease: leaseWrapper('application', events, { acquireError: acquisition }),
    withEvidence: leaseWrapper('evidence', events),
    withStaging: leaseWrapper('staging', events),
  });

  assert.throws(() => batch.withLeases(() => assert.fail('operation must not start')), acquisition);
  assert.deepEqual(events, ['application:acquire']);
});
