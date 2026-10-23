'use strict';

// Lease-owned bounded retention and journal recovery after hard stops.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { readAndVerifyE2eApplicationReceipt } = require('../e2e-application-publication');
const {
  byteSnapshot,
  publishE2eApplication,
  temporaryRoot,
  writeFile,
  writeLegacyApplication,
  writeManagedAppLease,
  writeProfile,
} = require('./test-fixtures');

test('managed retention bounds verified legacy v1 publications to one crash-safe compatibility copy', (context) => {
  const root = temporaryRoot(context);
  const cache = path.join(root, 'cache');
  const leaseId = writeManagedAppLease(cache);
  const legacy = [];
  for (const [index, marker] of ['legacy-old', 'legacy-middle', 'legacy-new'].entries()) {
    const profile = path.join(root, `legacy-profile-${index}`);
    writeProfile(profile, marker);
    const application = writeLegacyApplication({ cache, profile });
    const age = new Date(Date.now() - (3 - index) * 60_000);
    fs.utimesSync(application.applicationRoot, age, age);
    legacy.push(application);
  }
  const currentProfile = path.join(root, 'current-profile');
  writeProfile(currentProfile, 'current-v2');
  const published = publishE2eApplication({
    profileRoot: currentProfile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });

  assert.equal(published.retention.retainedLegacyHash, legacy[2].hash);
  assert.deepEqual(
    [...published.retention.removedLegacyHashes].sort(),
    [legacy[0].hash, legacy[1].hash].sort(),
  );
  assert.equal(fs.existsSync(legacy[0].applicationRoot), false);
  assert.equal(fs.existsSync(legacy[1].applicationRoot), false);
  assert.equal(fs.existsSync(legacy[2].applicationRoot), true);
  assert.deepEqual(fs.readdirSync(path.join(cache, 'manifests')), [`${legacy[2].hash}.json`]);
  assert.deepEqual(
    fs.readdirSync(path.join(cache, 'applications')).sort(),
    [legacy[2].hash, published.applicationHash].sort(),
  );
});

test('lease-owned retention keeps current plus one previous and recovers exact quarantine only', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  const leaseId = writeManagedAppLease(cache);

  writeProfile(profile, 'retained-one');
  const first = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });
  writeProfile(profile, 'retained-two');
  const second = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });
  writeProfile(profile, 'retained-three');
  const third = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });

  assert.deepEqual(
    fs.readdirSync(path.join(cache, 'applications')).sort(),
    [second.applicationHash, third.applicationHash].sort(),
  );
  assert.equal(fs.existsSync(first.applicationRoot), false);
  assert.equal(third.retention.currentHash, third.applicationHash);
  assert.equal(third.retention.previousHash, second.applicationHash);
  assert.deepEqual(third.retention.removedHashes, [first.applicationHash]);
  assert.deepEqual(
    fs.readdirSync(path.join(cache, '.osg-application-trash')),
    ['.osg-application-trash.json'],
  );

  const unchanged = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });
  assert.deepEqual(
    fs.readdirSync(path.join(cache, 'applications')).sort(),
    [second.applicationHash, third.applicationHash].sort(),
  );
  assert.equal(unchanged.retention.previousHash, second.applicationHash);

  const retiredName = `${second.applicationHash}--${'c'.repeat(32)}`;
  const retiredRoot = path.join(cache, '.osg-application-trash', retiredName);
  fs.renameSync(second.applicationRoot, retiredRoot);
  const recovered = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });
  assert.equal(recovered.applicationHash, third.applicationHash);
  assert.equal(fs.existsSync(retiredRoot), false);
  assert.deepEqual(fs.readdirSync(path.join(cache, 'applications')), [third.applicationHash]);

  fs.writeFileSync(path.join(cache, '.osg-application-trash', 'unknown.bin'), 'foreign');
  assert.throws(
    () => publishE2eApplication({
      profileRoot: profile,
      applicationsCacheRoot: cache,
      retentionLeaseId: leaseId,
    }),
    /unrecognized E2E application retirement bytes/u,
  );
  assert.equal(
    readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }).applicationHash,
    third.applicationHash,
  );
});

test('managed application bytes cannot change without the exact active lease', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  const leaseId = writeManagedAppLease(cache);
  writeProfile(profile, 'authorized');
  const published = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });
  const before = byteSnapshot(cache);
  writeProfile(profile, 'unauthorized-change');

  assert.throws(
    () => publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cache }),
    /requires its exact active cache lease/u,
  );
  assert.deepEqual(byteSnapshot(cache), before);
  assert.throws(
    () => publishE2eApplication({
      profileRoot: profile,
      applicationsCacheRoot: cache,
      retentionLeaseId: 'f'.repeat(32),
    }),
    /not owned by this process and managed-cache lease/u,
  );
  assert.deepEqual(byteSnapshot(cache), before);
  const leasePath = path.join(cache, '.osg-cache-lease');
  const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
  fs.writeFileSync(leasePath, `${JSON.stringify({
    ...lease,
    processCreatedUtc: '2026-01-01T00:00:00.0000000Z',
  })}\n`);
  assert.throws(
    () => publishE2eApplication({
      profileRoot: profile,
      applicationsCacheRoot: cache,
      retentionLeaseId: leaseId,
    }),
    /owner identity is stale or was reused/u,
  );
  assert.equal(
    readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }).applicationHash,
    published.applicationHash,
  );
});

test('lease journal recovers partial publication and partial retirement after a hard stop', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  const leaseId = writeManagedAppLease(cache);
  writeProfile(profile, 'journal-one');
  const first = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });
  writeProfile(profile, 'journal-two');
  const second = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });

  const operationsRoot = path.join(cache, '.osg-application-operations');
  const publishOperationId = '1'.repeat(32);
  const temporaryLeaf = `.publish-${'2'.repeat(64)}-${publishOperationId}`;
  writeFile(path.join(cache, 'applications', temporaryLeaf), 'workers/partial.bin', 'partial');
  fs.writeFileSync(
    path.join(operationsRoot, `.operation-${publishOperationId}.json`),
    `${JSON.stringify({
      schemaVersion: 2,
      owner: 'oneclick-subtitles-generator',
      kind: 'publish',
      operationId: publishOperationId,
      temporaryLeaf,
    })}\n`,
  );

  const retireOperationId = '3'.repeat(32);
  const retiredLeaf = `${first.applicationHash}--${retireOperationId}`;
  const retiredRoot = path.join(cache, '.osg-application-trash', retiredLeaf);
  fs.writeFileSync(
    path.join(operationsRoot, `.operation-${retireOperationId}.json`),
    `${JSON.stringify({
      schemaVersion: 2,
      owner: 'oneclick-subtitles-generator',
      kind: 'retire',
      operationId: retireOperationId,
      applicationHash: first.applicationHash,
      sourceLeaf: first.applicationHash,
      trashLeaf: retiredLeaf,
    })}\n`,
  );
  fs.renameSync(first.applicationRoot, retiredRoot);
  fs.rmSync(path.join(retiredRoot, '.osg-application-manifest.json'));
  fs.rmSync(path.join(retiredRoot, 'workers'), { recursive: true });

  const recovered = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });
  assert.equal(recovered.applicationHash, second.applicationHash);
  assert.equal(fs.existsSync(path.join(cache, 'applications', temporaryLeaf)), false);
  assert.equal(fs.existsSync(retiredRoot), false);
  assert.deepEqual(
    fs.readdirSync(operationsRoot),
    ['.osg-application-operations.json'],
  );
});

test('managed recovery removes exact receipt/journal temporaries and rejects lookalikes', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  const leaseId = writeManagedAppLease(cache);
  writeProfile(profile, 'temporary-recovery');
  const first = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });
  const receiptTemporary = path.join(
    cache,
    'receipts',
    `.receipt-${process.pid}-${'1'.repeat(32)}`,
  );
  const operationTemporary = path.join(
    cache,
    '.osg-application-operations',
    `.operation-${'2'.repeat(32)}.json.tmp-${process.pid}-${'3'.repeat(32)}`,
  );
  fs.writeFileSync(receiptTemporary, '{"partial":');
  fs.writeFileSync(operationTemporary, '{"partial":');
  const recovered = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });
  assert.equal(recovered.applicationHash, first.applicationHash);
  assert.equal(fs.existsSync(receiptTemporary), false);
  assert.equal(fs.existsSync(operationTemporary), false);

  const receiptLookalike = path.join(cache, 'receipts', `.receipt-0-${'4'.repeat(32)}`);
  fs.writeFileSync(receiptLookalike, 'foreign');
  assert.throws(() => publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  }), /unrecognized E2E application receipt entry/u);
  fs.rmSync(receiptLookalike);

  const journalLookalike = path.join(
    cache,
    '.osg-application-operations',
    `.operation-${'5'.repeat(32)}.json.tmp-not-owned`,
  );
  fs.writeFileSync(journalLookalike, 'foreign');
  assert.throws(() => publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  }), /unrecognized E2E application operation journal entry/u);
  assert.equal(fs.readFileSync(journalLookalike, 'utf8'), 'foreign');
});

test('operation marker temporary recovery is exact and a corrupt committed journal is retained', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  const leaseId = writeManagedAppLease(cache);
  writeProfile(profile, 'marker-recovery');
  const operationsRoot = path.join(cache, '.osg-application-operations');
  fs.mkdirSync(operationsRoot, { recursive: true });
  const markerTemporary = path.join(
    operationsRoot,
    `.osg-application-operations.json.tmp-${process.pid}-${'6'.repeat(32)}`,
  );
  fs.writeFileSync(markerTemporary, '{"partial":');
  publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });
  assert.equal(fs.existsSync(markerTemporary), false);

  const corruptJournal = path.join(operationsRoot, `.operation-${'7'.repeat(32)}.json`);
  fs.writeFileSync(corruptJournal, '{"partial":');
  assert.throws(() => publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  }), /Unexpected end of JSON input|valid JSON|operation journal/u);
  assert.equal(fs.readFileSync(corruptJournal, 'utf8'), '{"partial":');
});

