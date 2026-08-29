const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');

const {
  APPLICATION_BINARY,
  RESOURCE_DIRECTORIES,
  applicationManifestBytes,
  collectCargoProfileApplication,
  publishE2eApplication: publishApplicationWithoutTestProvenance,
  readAndVerifyE2eApplicationReceipt,
  resolveAbsoluteInput,
} = require('./e2e-application-publication');
const { readCurrentWindowsProcessIdentity } = require('./windows-process-identity.js');

const execFileAsync = promisify(execFile);
const TEST_SOURCE_PROVENANCE = Object.freeze({
  commit: '1'.repeat(40),
  tree: '2'.repeat(40),
  dirty: false,
});
const publishE2eApplication = (input) => publishApplicationWithoutTestProvenance({
  ...input,
  sourceProvenance: input.sourceProvenance ?? TEST_SOURCE_PROVENANCE,
});

const temporaryRoot = (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-e2e-application-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
};

const writeFile = (root, relative, bytes) => {
  const output = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, bytes);
  return output;
};

const writeProfile = (root, marker = 'alpha') => {
  fs.mkdirSync(root, { recursive: true });
  writeFile(root, 'osg-desktop.exe', Buffer.from(`MZ-e2e-${marker}`));
  writeFile(root, 'ui-fonts/font.woff2', Buffer.from(`font-${marker}`));
  writeFile(root, 'workers/osg_asr_worker.py', Buffer.from(`worker-${marker}`));
  writeFile(root, 'licenses/LICENSE', Buffer.from(`license-${marker}`));
  writeFile(root, 'deps/never-publish.dll', Buffer.from(`ignored-${marker}`));
  writeFile(root, 'osg_desktop.pdb', Buffer.from(`ignored-pdb-${marker}`));
};

const writeLegacyApplication = ({ cache, profile }) => {
  const collected = collectCargoProfileApplication(profile);
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    hashAlgorithm: 'sha256',
    entrypoint: APPLICATION_BINARY,
    resourceDirectories: RESOURCE_DIRECTORIES,
    directories: collected.directories,
    files: collected.files.map(({ path: relative, size, sha256 }) => ({
      path: relative, size, sha256,
    })),
  }, null, 2)}\n`, 'utf8');
  const hash = createHash('sha256').update(manifest).digest('hex');
  const applicationRoot = path.join(cache, 'applications', hash);
  for (const relative of collected.directories) {
    fs.mkdirSync(path.join(applicationRoot, ...relative.split('/')), { recursive: true });
  }
  for (const entry of collected.files) {
    const output = path.join(applicationRoot, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(entry.source, output);
  }
  const manifestPath = path.join(cache, 'manifests', `${hash}.json`);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, manifest);
  return { applicationRoot, hash, manifest, manifestPath };
};

const writeHistoricalV2Application = ({ cache, profile }) => {
  const collected = collectCargoProfileApplication(profile);
  const manifest = applicationManifestBytes(collected);
  const hash = createHash('sha256').update(manifest).digest('hex');
  const applicationRoot = path.join(cache, 'applications', hash);
  for (const relative of collected.directories) {
    fs.mkdirSync(path.join(applicationRoot, ...relative.split('/')), { recursive: true });
  }
  for (const entry of collected.files) {
    const output = path.join(applicationRoot, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(entry.source, output);
  }
  const manifestPath = path.join(applicationRoot, '.osg-application-manifest.json');
  fs.writeFileSync(manifestPath, manifest);
  const receiptPath = path.join(cache, 'receipts', 'current.json');
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    schemaVersion: 2,
    hashAlgorithm: 'sha256',
    applicationHash: hash,
    applicationRoot,
    binaryPath: path.join(applicationRoot, APPLICATION_BINARY),
    manifestPath,
    fileCount: collected.files.length,
    totalBytes: collected.files.reduce((total, entry) => total + entry.size, 0),
  }, null, 2)}\n`);
  return { applicationRoot, hash };
};

const writeManagedAppLease = (cache, leaseId = 'a'.repeat(32)) => {
  fs.mkdirSync(cache, { recursive: true });
  const rootId = 'b'.repeat(32);
  fs.writeFileSync(path.join(cache, '.osg-cache-entry.json'), `${JSON.stringify({
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId,
    lane: 'apps-e2e',
  })}\n`);
  fs.writeFileSync(path.join(cache, '.osg-cache-lease'), `${JSON.stringify({
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId,
    laneGroup: 'e2e',
    leaseId,
    processId: process.pid,
    processCreatedUtc: readCurrentWindowsProcessIdentity().processCreatedUtc,
  })}\n`);
  return leaseId;
};

const verbatimPath = (absolute) => (
  absolute.startsWith('\\\\')
    ? `\\\\?\\UNC\\${absolute.slice(2)}`
    : `\\\\?\\${absolute}`
);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const byteSnapshot = (root) => {
  if (!fs.existsSync(root)) return [];
  const entries = [];
  const visit = (directory) => {
    for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (child.isDirectory()) {
        entries.push([`${relative}/`, null]);
        visit(absolute);
      } else {
        entries.push([relative, fs.readFileSync(absolute).toString('hex')]);
      }
    }
  };
  visit(root);
  return entries;
};

test('unchanged publication preserves mtimes and one byte creates a new immutable application', async (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'external-applications-cache');
  writeProfile(profile);

  const first = publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cache });
  const tracked = path.join(first.applicationRoot, 'workers', 'osg_asr_worker.py');
  const firstTimes = {
    application: fs.statSync(first.applicationRoot).mtimeMs,
    file: fs.statSync(tracked).mtimeMs,
    manifest: fs.statSync(first.manifestPath).mtimeMs,
    receipt: fs.statSync(first.receiptPath).mtimeMs,
  };
  assert.equal(fs.existsSync(path.join(first.applicationRoot, 'deps')), false);
  assert.equal(fs.existsSync(path.join(first.applicationRoot, 'osg_desktop.pdb')), false);
  assert.deepEqual(
    readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }),
    {
      applicationHash: first.applicationHash,
      applicationRoot: first.applicationRoot,
      binaryPath: first.binaryPath,
      manifestPath: first.manifestPath,
      receiptPath: first.receiptPath,
      fileCount: first.fileCount,
      totalBytes: first.totalBytes,
      sourceProvenance: TEST_SOURCE_PROVENANCE,
    },
  );

  await sleep(40);
  const second = publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cache });
  assert.equal(second.applicationHash, first.applicationHash);
  assert.equal(second.applicationCreated, false);
  assert.equal(second.receiptChanged, false);
  assert.deepEqual({
    application: fs.statSync(first.applicationRoot).mtimeMs,
    file: fs.statSync(tracked).mtimeMs,
    manifest: fs.statSync(first.manifestPath).mtimeMs,
    receipt: fs.statSync(first.receiptPath).mtimeMs,
  }, firstTimes);

  const oldWorker = fs.readFileSync(tracked);
  fs.writeFileSync(path.join(profile, 'workers', 'osg_asr_worker.py'), Buffer.from('worker-alphb'));
  const third = publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cache });
  assert.notEqual(third.applicationHash, first.applicationHash);
  assert.ok(fs.readFileSync(tracked).equals(oldWorker));
  assert.equal(
    fs.readFileSync(path.join(third.applicationRoot, 'workers', 'osg_asr_worker.py'), 'utf8'),
    'worker-alphb',
  );
  assert.equal(
    readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }).applicationHash,
    third.applicationHash,
  );
});

test('source provenance is content-addressed and receipt drift fails closed', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  writeProfile(profile, 'provenance');

  assert.throws(
    () => publishApplicationWithoutTestProvenance({
      profileRoot: profile,
      applicationsCacheRoot: cache,
    }),
    /source provenance/u,
  );
  assert.equal(fs.existsSync(cache), false);

  const first = publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cache });
  const secondSource = {
    commit: '3'.repeat(40),
    tree: TEST_SOURCE_PROVENANCE.tree,
    dirty: false,
  };
  const second = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    sourceProvenance: secondSource,
  });
  assert.notEqual(second.applicationHash, first.applicationHash);
  assert.deepEqual(
    readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }).sourceProvenance,
    secondSource,
  );

  const receipt = JSON.parse(fs.readFileSync(second.receiptPath, 'utf8'));
  receipt.source.commit = TEST_SOURCE_PROVENANCE.commit;
  fs.writeFileSync(second.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  assert.throws(
    () => readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }),
    /receipt path\/hash or inventory/u,
  );
});

test('schema v2 publishes beside an untouched legacy v1 application and selects the v2 root', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  writeProfile(profile, 'legacy-source');
  const collected = collectCargoProfileApplication(profile);
  const legacyManifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    hashAlgorithm: 'sha256',
    entrypoint: APPLICATION_BINARY,
    resourceDirectories: RESOURCE_DIRECTORIES,
    directories: collected.directories,
    files: collected.files.map(({ path: relative, size, sha256 }) => ({
      path: relative,
      size,
      sha256,
    })),
  }, null, 2)}\n`, 'utf8');
  const legacyHash = createHash('sha256').update(legacyManifest).digest('hex');
  const legacyRoot = path.join(cache, 'applications', legacyHash);
  for (const relative of collected.directories) {
    fs.mkdirSync(path.join(legacyRoot, ...relative.split('/')), { recursive: true });
  }
  for (const entry of collected.files) {
    const output = path.join(legacyRoot, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(entry.source, output);
  }
  const legacyManifestPath = path.join(cache, 'manifests', `${legacyHash}.json`);
  fs.mkdirSync(path.dirname(legacyManifestPath), { recursive: true });
  fs.writeFileSync(legacyManifestPath, legacyManifest);
  const legacyReceiptPath = path.join(cache, 'receipts', 'current.json');
  fs.mkdirSync(path.dirname(legacyReceiptPath), { recursive: true });
  fs.writeFileSync(legacyReceiptPath, `${JSON.stringify({
    schemaVersion: 1,
    applicationHash: legacyHash,
    applicationRoot: legacyRoot,
  })}\n`);
  const legacyBinaryBefore = fs.readFileSync(path.join(legacyRoot, APPLICATION_BINARY));
  const legacyManifestBefore = fs.readFileSync(legacyManifestPath);
  const leaseId = writeManagedAppLease(cache, 'd'.repeat(32));

  const published = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });
  assert.notEqual(published.applicationHash, legacyHash);
  assert.notEqual(published.applicationRoot, legacyRoot);
  assert.ok(fs.readFileSync(path.join(legacyRoot, APPLICATION_BINARY)).equals(legacyBinaryBefore));
  assert.ok(fs.readFileSync(legacyManifestPath).equals(legacyManifestBefore));
  assert.equal(fs.existsSync(path.join(legacyRoot, '.osg-application-manifest.json')), false);
  assert.deepEqual(
    fs.readdirSync(path.join(cache, 'applications')).sort(),
    [legacyHash, published.applicationHash].sort(),
  );
  assert.equal(
    readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }).applicationHash,
    published.applicationHash,
  );
});

test('a source-bound publication migrates a provenance-less v2 receipt as historical', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  writeProfile(profile, 'historical-v2');
  const historical = writeHistoricalV2Application({ cache, profile });
  const leaseId = writeManagedAppLease(cache, 'e'.repeat(32));

  const published = publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    retentionLeaseId: leaseId,
  });
  assert.notEqual(published.applicationHash, historical.hash);
  assert.equal(fs.existsSync(historical.applicationRoot), true);
  assert.deepEqual(
    readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }).sourceProvenance,
    TEST_SOURCE_PROVENANCE,
  );
});

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

test('a Cargo hardlink is accepted but published files are independent', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  writeProfile(profile);
  const seed = path.join(root, 'cargo-seed.exe');
  fs.renameSync(path.join(profile, 'osg-desktop.exe'), seed);
  fs.linkSync(seed, path.join(profile, 'osg-desktop.exe'));
  assert.ok(fs.statSync(path.join(profile, 'osg-desktop.exe')).nlink >= 2);

  const result = publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cache });
  assert.equal(fs.statSync(result.binaryPath).nlink, 1);
  fs.writeFileSync(seed, Buffer.from('changed-through-cargo-hardlink'));
  assert.equal(fs.readFileSync(result.binaryPath, 'utf8'), 'MZ-e2e-alpha');
});

test('interruption and a changing Cargo profile preserve the previous receipt', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  writeProfile(profile, 'one');
  const first = publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cache });
  const receiptBefore = fs.readFileSync(first.receiptPath);

  writeProfile(profile, 'two');
  assert.throws(() => publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    failAt: 'before-application-commit',
  }), /injected interruption before application commit/u);
  assert.ok(fs.readFileSync(first.receiptPath).equals(receiptBefore));
  assert.deepEqual(fs.readdirSync(path.join(cache, 'applications')), [first.applicationHash]);
  assert.equal(fs.statSync(first.manifestPath).nlink, 1);

  assert.throws(() => publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    afterCopy: () => fs.writeFileSync(
      path.join(profile, 'workers', 'late.py'),
      'appeared during publication',
    ),
  }), /Cargo profile changed while/u);
  assert.ok(fs.readFileSync(first.receiptPath).equals(receiptBefore));

  fs.rmSync(path.join(profile, 'workers', 'late.py'));
  writeProfile(profile, 'three');
  assert.throws(() => publishE2eApplication({
    profileRoot: profile,
    applicationsCacheRoot: cache,
    failAt: 'before-receipt-commit',
  }), /injected interruption before receipt commit/u);
  assert.ok(fs.readFileSync(first.receiptPath).equals(receiptBefore));
  const verified = readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache });
  assert.equal(verified.applicationHash, first.applicationHash);
  assert.equal(fs.readFileSync(verified.binaryPath, 'utf8'), 'MZ-e2e-one');
  assert.equal(
    fs.readdirSync(path.join(cache, 'applications'))
      .filter((name) => name.startsWith('.publish-')).length,
    0,
  );
});

test('concurrent identical publishers converge on one verified immutable application', async (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  const repository = path.join(root, 'source-repository');
  fs.mkdirSync(repository);
  execFileSync('git', ['init', '--quiet'], { cwd: repository, windowsHide: true });
  writeFile(repository, 'tracked.txt', 'source');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repository, windowsHide: true });
  execFileSync('git', [
    '-c', 'user.name=OSG Test', '-c', 'user.email=osg@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ], { cwd: repository, windowsHide: true });
  writeProfile(profile, 'concurrent');
  for (let index = 0; index < 40; index += 1) {
    writeFile(profile, `workers/nested/${String(index).padStart(2, '0')}.txt`, `file-${index}`);
  }
  const script = path.resolve(__dirname, 'e2e-application-publication.js');
  const invocations = Array.from({ length: 8 }, () => execFileAsync(process.execPath, [
    script,
    '--profile-root', profile,
    '--applications-cache-root', cache,
    '--repository-root', repository,
  ], { encoding: 'utf8', windowsHide: true }));
  const results = (await Promise.all(invocations)).map(({ stdout }) => JSON.parse(stdout));
  assert.equal(new Set(results.map(({ applicationHash }) => applicationHash)).size, 1);
  assert.deepEqual(
    fs.readdirSync(path.join(cache, 'applications')),
    [results[0].applicationHash],
  );
  const verified = readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache });
  assert.equal(verified.applicationHash, results[0].applicationHash);
  assert.equal(path.dirname(verified.manifestPath), verified.applicationRoot);
  assert.equal(fs.statSync(verified.manifestPath).nlink, 1);
  assert.equal(fs.existsSync(path.join(cache, 'manifests')), false);
  assert.equal(fs.readFileSync(path.join(verified.applicationRoot, 'workers', 'nested', '39.txt'), 'utf8'), 'file-39');
  assert.equal(
    fs.readdirSync(path.join(verified.applicationRoot, 'workers', 'nested')).length,
    40,
  );
});

test('corrupted immutable application, manifest, and receipt are refused', (context) => {
  const root = temporaryRoot(context);

  const profileOne = path.join(root, 'profile-one');
  const cacheOne = path.join(root, 'cache-one');
  writeProfile(profileOne);
  const first = publishE2eApplication({ profileRoot: profileOne, applicationsCacheRoot: cacheOne });
  fs.writeFileSync(path.join(first.applicationRoot, 'licenses', 'LICENSE'), 'corrupt');
  assert.throws(
    () => readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cacheOne }),
    /corrupted inventory/u,
  );
  assert.throws(
    () => publishE2eApplication({ profileRoot: profileOne, applicationsCacheRoot: cacheOne }),
    /corrupted inventory/u,
  );

  const profileTwo = path.join(root, 'profile-two');
  const cacheTwo = path.join(root, 'cache-two');
  writeProfile(profileTwo);
  const second = publishE2eApplication({ profileRoot: profileTwo, applicationsCacheRoot: cacheTwo });
  fs.writeFileSync(second.manifestPath, '{"corrupt":true}\n');
  assert.throws(
    () => readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cacheTwo }),
    /manifest path\/hash mismatch/u,
  );

  const profileThree = path.join(root, 'profile-three');
  const cacheThree = path.join(root, 'cache-three');
  writeProfile(profileThree);
  const third = publishE2eApplication({ profileRoot: profileThree, applicationsCacheRoot: cacheThree });
  const receipt = JSON.parse(fs.readFileSync(third.receiptPath, 'utf8'));
  receipt.applicationRoot = path.join(root, 'elsewhere');
  fs.writeFileSync(third.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  assert.throws(
    () => readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cacheThree }),
    /receipt path\/hash or inventory/u,
  );
  assert.throws(
    () => readAndVerifyE2eApplicationReceipt({
      applicationsCacheRoot: cacheThree,
      receiptPath: path.join(root, 'wrong-receipt.json'),
    }),
    /receipt path does not match/u,
  );
});

test('extra files and externally hard-linked published bytes are refused', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  const cache = path.join(root, 'cache');
  writeProfile(profile);
  const result = publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cache });
  writeFile(result.applicationRoot, 'workers/unreviewed.py', 'extra');
  assert.throws(
    () => readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }),
    /corrupted inventory/u,
  );

  const profileTwo = path.join(root, 'profile-two');
  const cacheTwo = path.join(root, 'cache-two');
  writeProfile(profileTwo);
  const second = publishE2eApplication({ profileRoot: profileTwo, applicationsCacheRoot: cacheTwo });
  const external = path.join(root, 'external-link');
  fs.linkSync(second.binaryPath, external);
  assert.throws(
    () => readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cacheTwo }),
    /must not be hard-linked/u,
  );
});

test('absolute-path, traversal, overlap, junction, and reparse boundaries fail closed', (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, 'profile');
  writeProfile(profile);
  assert.throws(() => resolveAbsoluteInput('relative', 'test path'), /must be absolute/u);
  assert.throws(
    () => resolveAbsoluteInput(`${root}${path.sep}cache${path.sep}..${path.sep}escape`, 'test path'),
    /traversal/u,
  );
  for (const spelling of [
    verbatimPath(path.join(root, 'namespace-cache')),
    `\\\\.\\${path.join(root, 'namespace-cache')}`,
    `\\??\\${path.join(root, 'namespace-cache')}`,
  ]) {
    assert.throws(
      () => resolveAbsoluteInput(spelling, 'test path'),
      /Windows (?:verbatim|device|nt) namespace/u,
    );
  }
  assert.throws(
    () => resolveAbsoluteInput(`${path.join(root, 'trailing-dot')}.`, 'test path'),
    /trailing-dot or trailing-space/u,
  );
  assert.throws(
    () => resolveAbsoluteInput(`${path.join(root, 'trailing-space')} `, 'test path'),
    /trailing-dot or trailing-space/u,
  );
  assert.throws(
    () => publishE2eApplication({
      profileRoot: profile,
      applicationsCacheRoot: path.join(profile, 'cache'),
    }),
    /must not overlap/u,
  );
  const aliasedCache = path.join(profile, 'namespace-cache');
  assert.throws(
    () => publishE2eApplication({
      profileRoot: profile,
      applicationsCacheRoot: verbatimPath(aliasedCache),
    }),
    /Windows verbatim namespace/u,
  );
  assert.equal(fs.existsSync(aliasedCache), false);

  const overlapAlias = path.join(root, 'profile-overlap-alias');
  fs.symlinkSync(profile, overlapAlias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => publishE2eApplication({
      profileRoot: profile,
      applicationsCacheRoot: path.join(overlapAlias, 'cache'),
    }),
    /must not overlap/u,
  );

  const sourceTarget = path.join(root, 'source-target');
  const sourceLink = path.join(root, 'source-link');
  writeProfile(sourceTarget, 'linked-root');
  fs.symlinkSync(sourceTarget, sourceLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => publishE2eApplication({
      profileRoot: sourceLink,
      applicationsCacheRoot: path.join(root, 'cache-one'),
    }),
    /symlink, junction, or reparse point|redirected filesystem path/u,
  );

  const nestedTarget = path.join(root, 'nested-target');
  fs.mkdirSync(nestedTarget);
  fs.symlinkSync(
    nestedTarget,
    path.join(profile, 'workers', 'nested-link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(
    () => publishE2eApplication({
      profileRoot: profile,
      applicationsCacheRoot: path.join(root, 'cache-two'),
    }),
    /symlink, junction, or reparse point|redirected filesystem path/u,
  );
  fs.unlinkSync(path.join(profile, 'workers', 'nested-link'));

  const cacheTarget = path.join(root, 'cache-target');
  const cacheLink = path.join(root, 'cache-link');
  fs.mkdirSync(cacheTarget);
  fs.symlinkSync(cacheTarget, cacheLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => publishE2eApplication({ profileRoot: profile, applicationsCacheRoot: cacheLink }),
    /symlink, junction, or reparse point|redirected filesystem path/u,
  );

  const cacheWithRedirect = path.join(root, 'cache-with-redirect');
  const applicationsTarget = path.join(root, 'applications-target');
  fs.mkdirSync(cacheWithRedirect);
  fs.mkdirSync(applicationsTarget);
  fs.symlinkSync(
    applicationsTarget,
    path.join(cacheWithRedirect, 'applications'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(
    () => publishE2eApplication({
      profileRoot: profile,
      applicationsCacheRoot: cacheWithRedirect,
    }),
    /symlink, junction, or reparse point|redirected filesystem path/u,
  );
});

test('missing or redirected required payload entries are refused', (context) => {
  const root = temporaryRoot(context);
  const missing = path.join(root, 'missing');
  writeProfile(missing);
  fs.rmSync(path.join(missing, 'licenses'), { recursive: true });
  assert.throws(
    () => publishE2eApplication({
      profileRoot: missing,
      applicationsCacheRoot: path.join(root, 'missing-cache'),
    }),
    /ENOENT|must be a real directory/u,
  );

  const linked = path.join(root, 'linked-file');
  writeProfile(linked);
  const external = path.join(root, 'external-workers');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'osg_asr_worker.py'), 'external');
  fs.rmSync(path.join(linked, 'workers'), { recursive: true });
  fs.symlinkSync(
    external,
    path.join(linked, 'workers'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(
    () => publishE2eApplication({
      profileRoot: linked,
      applicationsCacheRoot: path.join(root, 'linked-cache'),
    }),
    /symlink, junction, or reparse point|redirected filesystem path/u,
  );
});
