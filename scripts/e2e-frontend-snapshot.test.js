const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');

const {
  createManagedFrontendWorkspace,
  publishFrontendSnapshot,
  releaseManagedFrontendWorkspace,
  resolveAbsoluteInput,
} = require('./e2e-frontend-snapshot');
const { readCurrentWindowsProcessIdentity } = require('./windows-process-identity.js');

const execFileAsync = promisify(execFile);

const temporaryRoot = (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-e2e-snapshot-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

const writeTree = (root, marker = 'alpha') => {
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), `<main>${marker}</main>`);
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), `export default ${JSON.stringify(marker)};`);
  fs.writeFileSync(path.join(root, 'assets', 'binary.bin'), Buffer.from([0, 1, 2, marker.length, 255]));
};

const writeJson = (destination, value) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
};

const managedFrontendLane = (root, leaseId = 'a'.repeat(32)) => {
  const cacheRoot = path.join(root, 'managed-cache', 'frontend', 'e2e');
  const rootId = 'b'.repeat(32);
  fs.mkdirSync(cacheRoot, { recursive: true });
  writeJson(path.join(root, 'managed-cache', 'frontend', '.osg-cache-area.json'), {
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId,
    area: 'frontend',
  });
  writeJson(path.join(cacheRoot, '.osg-cache-entry.json'), {
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId,
    lane: 'frontend-e2e',
  });
  writeJson(path.join(cacheRoot, '.osg-cache-lease'), {
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId,
    laneGroup: 'e2e',
    leaseId,
    processId: process.pid,
    processCreatedUtc: readCurrentWindowsProcessIdentity().processCreatedUtc,
  });
  return Object.freeze({ cacheRoot, leaseId, rootId });
};

const verbatimPath = (absolute) => (
  absolute.startsWith('\\\\')
    ? `\\\\?\\UNC\\${absolute.slice(2)}`
    : `\\\\?\\${absolute}`
);

test('unchanged publication reuses immutable bytes and a byte change creates a new hash', async (context) => {
  const root = temporaryRoot(context);
  const source = path.join(root, 'source');
  const cache = path.join(root, 'cache');
  writeTree(source);
  const first = publishFrontendSnapshot({ sourceRoot: source, cacheRoot: cache });
  const tracked = path.join(first.snapshotRoot, 'index.html');
  const firstFileTime = fs.statSync(tracked).mtimeMs;
  const firstDirectoryTime = fs.statSync(first.snapshotRoot).mtimeMs;
  const firstReceiptTime = fs.statSync(first.receiptPath).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = publishFrontendSnapshot({ sourceRoot: source, cacheRoot: cache });
  assert.equal(second.snapshotHash, first.snapshotHash);
  assert.equal(second.snapshotCreated, false);
  assert.equal(second.receiptChanged, false);
  assert.equal(fs.statSync(tracked).mtimeMs, firstFileTime);
  assert.equal(fs.statSync(first.snapshotRoot).mtimeMs, firstDirectoryTime);
  assert.equal(fs.statSync(first.receiptPath).mtimeMs, firstReceiptTime);

  fs.writeFileSync(path.join(source, 'assets', 'app.js'), 'changed by one byte!');
  const third = publishFrontendSnapshot({ sourceRoot: source, cacheRoot: cache });
  assert.notEqual(third.snapshotHash, first.snapshotHash);
  assert.equal(fs.readFileSync(path.join(first.snapshotRoot, 'assets', 'app.js'), 'utf8'), 'export default "alpha";');
  assert.equal(fs.readFileSync(path.join(third.snapshotRoot, 'assets', 'app.js'), 'utf8'), 'changed by one byte!');
});

test('interruption cannot replace the previous snapshot receipt', (context) => {
  const root = temporaryRoot(context);
  const source = path.join(root, 'source');
  const cache = path.join(root, 'cache');
  writeTree(source, 'one');
  const first = publishFrontendSnapshot({ sourceRoot: source, cacheRoot: cache });
  const receiptBefore = fs.readFileSync(first.receiptPath);

  writeTree(source, 'two');
  assert.throws(() => publishFrontendSnapshot({
    sourceRoot: source,
    cacheRoot: cache,
    failAt: 'before-snapshot-commit',
  }), /injected interruption/u);
  assert.ok(fs.readFileSync(first.receiptPath).equals(receiptBefore));
  assert.equal(fs.readFileSync(path.join(first.snapshotRoot, 'index.html'), 'utf8'), '<main>one</main>');

  writeTree(source, 'three');
  assert.throws(() => publishFrontendSnapshot({
    sourceRoot: source,
    cacheRoot: cache,
    failAt: 'before-receipt-commit',
  }), /injected interruption/u);
  assert.ok(fs.readFileSync(first.receiptPath).equals(receiptBefore));
  const receipt = JSON.parse(receiptBefore);
  assert.equal(receipt.snapshotHash, first.snapshotHash);
  assert.equal(fs.readFileSync(path.join(receipt.snapshotRoot, 'index.html'), 'utf8'), '<main>one</main>');
});

test('concurrent publishers converge on one complete snapshot without mixed files', async (context) => {
  const root = temporaryRoot(context);
  const source = path.join(root, 'source');
  const cache = path.join(root, 'cache');
  writeTree(source, 'concurrent');
  for (let index = 0; index < 40; index += 1) {
    fs.writeFileSync(path.join(source, 'assets', `${String(index).padStart(2, '0')}.txt`), `file-${index}`);
  }
  const script = path.resolve(__dirname, 'e2e-frontend-snapshot.js');
  const invocations = Array.from({ length: 8 }, () => execFileAsync(process.execPath, [
    script,
    '--source', source,
    '--cache-root', cache,
  ], { encoding: 'utf8' }));
  const results = (await Promise.all(invocations)).map(({ stdout }) => JSON.parse(stdout));
  assert.equal(new Set(results.map((result) => result.snapshotHash)).size, 1);
  assert.equal(fs.readdirSync(path.join(cache, 'snapshots')).length, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(cache, 'receipts', 'current.json'), 'utf8'));
  assert.equal(receipt.snapshotHash, results[0].snapshotHash);
  assert.equal(fs.readdirSync(path.join(receipt.snapshotRoot, 'assets')).length, 42);
  assert.equal(fs.readFileSync(path.join(receipt.snapshotRoot, 'assets', '39.txt'), 'utf8'), 'file-39');
  assert.equal(fs.readFileSync(path.join(receipt.snapshotRoot, 'index.html'), 'utf8'), '<main>concurrent</main>');
});

test('source, destination, traversal, and overlapping roots are refused', (context) => {
  const root = temporaryRoot(context);
  const source = path.join(root, 'source');
  const cache = path.join(root, 'cache');
  writeTree(source);
  assert.throws(
    () => resolveAbsoluteInput(`${root}${path.sep}cache${path.sep}..${path.sep}escape`, 'test root'),
    /traversal/u,
  );
  for (const spelling of [
    verbatimPath(path.join(root, 'namespace-cache')),
    `\\\\.\\${path.join(root, 'namespace-cache')}`,
    `\\??\\${path.join(root, 'namespace-cache')}`,
  ]) {
    assert.throws(
      () => resolveAbsoluteInput(spelling, 'test root'),
      /Windows (?:verbatim|device|nt) namespace/u,
    );
  }
  assert.throws(
    () => resolveAbsoluteInput(`${path.join(root, 'trailing-dot')}.`, 'test root'),
    /trailing-dot or trailing-space/u,
  );
  assert.throws(
    () => resolveAbsoluteInput(`${path.join(root, 'trailing-space')} `, 'test root'),
    /trailing-dot or trailing-space/u,
  );
  assert.throws(
    () => publishFrontendSnapshot({ sourceRoot: source, cacheRoot: path.join(source, 'cache') }),
    /must not overlap/u,
  );
  const aliasedCache = path.join(source, 'namespace-cache');
  assert.throws(
    () => publishFrontendSnapshot({ sourceRoot: source, cacheRoot: verbatimPath(aliasedCache) }),
    /Windows verbatim namespace/u,
  );
  assert.equal(fs.existsSync(aliasedCache), false);

  const overlapAlias = path.join(root, 'source-overlap-alias');
  fs.symlinkSync(source, overlapAlias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => publishFrontendSnapshot({
      sourceRoot: source,
      cacheRoot: path.join(overlapAlias, 'cache'),
    }),
    /must not overlap/u,
  );

  const sourceTarget = path.join(root, 'source-target');
  const linkedSource = path.join(root, 'source-link');
  writeTree(sourceTarget, 'linked');
  fs.symlinkSync(sourceTarget, linkedSource, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => publishFrontendSnapshot({ sourceRoot: linkedSource, cacheRoot: cache }),
    /symlink, junction, or reparse point|redirected filesystem path/u,
  );

  const cacheTarget = path.join(root, 'cache-target');
  const linkedCache = path.join(root, 'cache-link');
  fs.mkdirSync(cacheTarget);
  fs.symlinkSync(cacheTarget, linkedCache, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => publishFrontendSnapshot({ sourceRoot: source, cacheRoot: linkedCache }),
    /symlink, junction, or reparse point|redirected filesystem path/u,
  );

  const nestedDestinationCache = path.join(root, 'nested-destination-cache');
  const nestedDestinationTarget = path.join(root, 'nested-destination-target');
  fs.mkdirSync(nestedDestinationCache);
  fs.mkdirSync(nestedDestinationTarget);
  fs.symlinkSync(
    nestedDestinationTarget,
    path.join(nestedDestinationCache, 'snapshots'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(
    () => publishFrontendSnapshot({ sourceRoot: source, cacheRoot: nestedDestinationCache }),
    /symlink, junction, or reparse point|redirected filesystem path/u,
  );

  const nestedLinkTarget = path.join(root, 'nested-target');
  fs.mkdirSync(nestedLinkTarget);
  fs.symlinkSync(nestedLinkTarget, path.join(source, 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => publishFrontendSnapshot({ sourceRoot: source, cacheRoot: path.join(root, 'clean-cache') }),
    /symlink, junction, or reparse point/u,
  );
});

test('managed publication retains exactly the current and previous verified snapshots', (context) => {
  const root = temporaryRoot(context);
  const source = path.join(root, 'source');
  const managed = managedFrontendLane(root);
  writeTree(source, 'one');
  const first = publishFrontendSnapshot({
    sourceRoot: source,
    cacheRoot: managed.cacheRoot,
    retentionLeaseId: managed.leaseId,
  });
  writeTree(source, 'two');
  const second = publishFrontendSnapshot({
    sourceRoot: source,
    cacheRoot: managed.cacheRoot,
    retentionLeaseId: managed.leaseId,
  });
  writeTree(source, 'three');
  const third = publishFrontendSnapshot({
    sourceRoot: source,
    cacheRoot: managed.cacheRoot,
    retentionLeaseId: managed.leaseId,
  });

  assert.deepEqual(new Set(third.retainedSnapshotHashes), new Set([third.snapshotHash, second.snapshotHash]));
  assert.deepEqual(third.prunedSnapshotHashes, [first.snapshotHash]);
  assert.deepEqual(
    new Set(fs.readdirSync(path.join(managed.cacheRoot, 'snapshots'))),
    new Set([third.snapshotHash, second.snapshotHash]),
  );
  assert.deepEqual(
    new Set(fs.readdirSync(path.join(managed.cacheRoot, 'manifests'))),
    new Set([`${third.snapshotHash}.json`, `${second.snapshotHash}.json`]),
  );
  const current = JSON.parse(fs.readFileSync(path.join(managed.cacheRoot, 'receipts', 'current.json'), 'utf8'));
  const retention = JSON.parse(fs.readFileSync(path.join(managed.cacheRoot, 'receipts', 'retention.json'), 'utf8'));
  assert.equal(current.snapshotHash, third.snapshotHash);
  assert.deepEqual(retention, {
    schemaVersion: 1,
    currentSnapshotHash: third.snapshotHash,
    previousSnapshotHash: second.snapshotHash,
  });
  assert.equal(fs.readdirSync(path.join(managed.cacheRoot, '.osg-frontend-trash')).length, 0);
  assert.equal(fs.readdirSync(path.join(managed.cacheRoot, '.osg-frontend-journals')).length, 0);
});

test('a snapshot committed before a hard receipt boundary is never mistaken for previous', (context) => {
  const root = temporaryRoot(context);
  const source = path.join(root, 'source');
  const managed = managedFrontendLane(root);
  writeTree(source, 'last receipt');
  const lastReceipt = publishFrontendSnapshot({
    sourceRoot: source,
    cacheRoot: managed.cacheRoot,
    retentionLeaseId: managed.leaseId,
  });
  writeTree(source, 'orphan before receipt');
  let orphanHash;
  assert.throws(() => {
    try {
      publishFrontendSnapshot({
        sourceRoot: source,
        cacheRoot: managed.cacheRoot,
        retentionLeaseId: managed.leaseId,
        failAt: 'before-receipt-commit',
      });
    } finally {
      const hashes = fs.readdirSync(path.join(managed.cacheRoot, 'snapshots'));
      orphanHash = hashes.find((hash) => hash !== lastReceipt.snapshotHash);
    }
  }, /injected interruption/u);
  assert.match(orphanHash, /^[0-9a-f]{64}$/u);

  writeTree(source, 'new current');
  const current = publishFrontendSnapshot({
    sourceRoot: source,
    cacheRoot: managed.cacheRoot,
    retentionLeaseId: managed.leaseId,
  });
  assert.deepEqual(
    new Set(current.retainedSnapshotHashes),
    new Set([current.snapshotHash, lastReceipt.snapshotHash]),
  );
  assert.deepEqual(current.prunedSnapshotHashes, [orphanHash]);
});

test('managed mutation requires the exact process-held lease and fails before adopting bytes', (context) => {
  const root = temporaryRoot(context);
  const source = path.join(root, 'source');
  const managed = managedFrontendLane(root);
  writeTree(source);
  const before = fs.readdirSync(managed.cacheRoot).sort();

  for (const retentionLeaseId of [undefined, 'c'.repeat(32), '../not-a-lease']) {
    assert.throws(
      () => publishFrontendSnapshot({
        sourceRoot: source,
        cacheRoot: managed.cacheRoot,
        retentionLeaseId,
      }),
      /exact active E2E lease id|does not own the active managed frontend lane/u,
    );
    assert.deepEqual(fs.readdirSync(managed.cacheRoot).sort(), before);
  }

  const leasePath = path.join(managed.cacheRoot, '.osg-cache-lease');
  const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
  writeJson(leasePath, { ...lease, processId: process.pid + 1 });
  assert.throws(
    () => publishFrontendSnapshot({
      sourceRoot: source,
      cacheRoot: managed.cacheRoot,
      retentionLeaseId: managed.leaseId,
    }),
    /does not own the active managed frontend lane/u,
  );
  writeJson(leasePath, {
    ...lease,
    processCreatedUtc: '2026-01-01T00:00:00.0000000Z',
  });
  assert.throws(
    () => publishFrontendSnapshot({
      sourceRoot: source,
      cacheRoot: managed.cacheRoot,
      retentionLeaseId: managed.leaseId,
    }),
    /owner identity is stale or was reused/u,
  );
  fs.rmSync(leasePath);
  assert.throws(
    () => publishFrontendSnapshot({
      sourceRoot: source,
      cacheRoot: managed.cacheRoot,
      retentionLeaseId: managed.leaseId,
    }),
    /requires an active E2E lease/u,
  );
  assert.deepEqual(fs.readdirSync(managed.cacheRoot).sort(), ['.osg-cache-entry.json']);
});

test('a plain isolated cache remains supported and is not mistaken for a managed mutation target', (context) => {
  const root = temporaryRoot(context);
  const source = path.join(root, 'source');
  const cache = path.join(root, 'plain-cache');
  for (const marker of ['one', 'two', 'three']) {
    writeTree(source, marker);
    publishFrontendSnapshot({ sourceRoot: source, cacheRoot: cache });
  }
  assert.equal(fs.readdirSync(path.join(cache, 'snapshots')).length, 3);
  assert.equal(fs.existsSync(path.join(cache, 'receipts', 'retention.json')), false);
  assert.throws(
    () => publishFrontendSnapshot({
      sourceRoot: source,
      cacheRoot: cache,
      retentionLeaseId: 'd'.repeat(32),
    }),
    /cannot authorize an unmanaged cache root/u,
  );
});

test('the next exact lease recovers only journal-owned interrupted publisher and trash paths', (context) => {
  const root = temporaryRoot(context);
  const source = path.join(root, 'source');
  const managed = managedFrontendLane(root);
  writeTree(source, 'stable');
  const stable = publishFrontendSnapshot({
    sourceRoot: source,
    cacheRoot: managed.cacheRoot,
    retentionLeaseId: managed.leaseId,
  });
  const transactionId = 'c'.repeat(32);
  const temporaryLeaf = `.publish-${stable.snapshotHash}-${transactionId}`;
  const temporary = path.join(managed.cacheRoot, 'snapshots', temporaryLeaf);
  fs.mkdirSync(temporary);
  fs.writeFileSync(path.join(temporary, 'partial.bin'), 'interrupted');
  writeJson(path.join(managed.cacheRoot, '.osg-frontend-journals', `${transactionId}.json`), {
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId: managed.rootId,
    transactionId,
    kind: 'snapshot-publication',
    snapshotHash: stable.snapshotHash,
    ownedLeaf: temporaryLeaf,
  });
  const pruneId = 'd'.repeat(32);
  const trashLeaf = `prune-${stable.snapshotHash}-${pruneId}`;
  const trash = path.join(managed.cacheRoot, '.osg-frontend-trash', trashLeaf);
  fs.mkdirSync(trash);
  fs.writeFileSync(path.join(trash, 'partial.bin'), 'interrupted prune');
  writeJson(path.join(managed.cacheRoot, '.osg-frontend-journals', `${pruneId}.json`), {
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId: managed.rootId,
    transactionId: pruneId,
    kind: 'snapshot-retention',
    snapshotHash: stable.snapshotHash,
    ownedLeaf: trashLeaf,
  });
  const recovered = publishFrontendSnapshot({
    sourceRoot: source,
    cacheRoot: managed.cacheRoot,
    retentionLeaseId: managed.leaseId,
  });
  assert.equal(recovered.snapshotHash, stable.snapshotHash);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.existsSync(trash), false);
  assert.equal(fs.readdirSync(path.join(managed.cacheRoot, '.osg-frontend-journals')).length, 0);

  const legacyToken = '7'.repeat(24);
  const legacySnapshot = path.join(
    managed.cacheRoot,
    'snapshots',
    `.publish-${stable.snapshotHash}-999-${legacyToken}`,
  );
  fs.mkdirSync(legacySnapshot);
  fs.writeFileSync(path.join(legacySnapshot, 'partial.bin'), 'foreign exact-shaped bytes');
  const manifestTemporary = path.join(
    managed.cacheRoot,
    'manifests',
    `${stable.snapshotHash}.json.publish-999-${legacyToken}`,
  );
  fs.writeFileSync(manifestTemporary, 'foreign exact-shaped manifest');
  const receiptTemporary = path.join(managed.cacheRoot, 'receipts', `.receipt-999-${legacyToken}`);
  fs.writeFileSync(receiptTemporary, 'foreign exact-shaped receipt');
  const layoutTemporary = path.join(
    managed.cacheRoot,
    `.osg-frontend-snapshot-cache.json.publish-999-${legacyToken}`,
  );
  fs.writeFileSync(layoutTemporary, 'foreign exact-shaped marker');
  assert.throws(
    () => publishFrontendSnapshot({
      sourceRoot: source,
      cacheRoot: managed.cacheRoot,
      retentionLeaseId: managed.leaseId,
    }),
    /has no durable operation allocation/u,
  );
  for (const foreignExactPath of [
    legacySnapshot, manifestTemporary, receiptTemporary, layoutTemporary,
  ]) {
    assert.equal(fs.existsSync(foreignExactPath), true);
    fs.rmSync(foreignExactPath, { recursive: true, force: true });
  }
  const atomicJournalLookalike = path.join(
    managed.cacheRoot,
    '.osg-frontend-journals',
    `.new-${'f'.repeat(32)}.json`,
  );
  fs.writeFileSync(atomicJournalLookalike, '{"partial":true');
  assert.throws(
    () => publishFrontendSnapshot({
      sourceRoot: source,
      cacheRoot: managed.cacheRoot,
      retentionLeaseId: managed.leaseId,
    }),
    /has no committed ownership authority/u,
  );
  assert.equal(fs.readFileSync(atomicJournalLookalike, 'utf8'), '{"partial":true');
  fs.rmSync(atomicJournalLookalike);

  const foreignLeaf = `.publish-${stable.snapshotHash}-${'e'.repeat(32)}`;
  const foreign = path.join(managed.cacheRoot, 'snapshots', foreignLeaf);
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'do-not-guess.txt'), 'unknown ownership');
  assert.throws(
    () => publishFrontendSnapshot({
      sourceRoot: source,
      cacheRoot: managed.cacheRoot,
      retentionLeaseId: managed.leaseId,
    }),
    /unrecognized frontend snapshot entry/u,
  );
  assert.equal(fs.readFileSync(path.join(foreign, 'do-not-guess.txt'), 'utf8'), 'unknown ownership');
});

test('managed frontend build work stays in the leased lane and is removed by its exact contract', (context) => {
  const root = temporaryRoot(context);
  const managed = managedFrontendLane(root);
  const workspace = createManagedFrontendWorkspace({
    cacheRoot: managed.cacheRoot,
    retentionLeaseId: managed.leaseId,
  });
  assert.ok(workspace.workspaceRoot.startsWith(path.join(managed.cacheRoot, '.osg-frontend-workspaces')));
  const source = path.join(workspace.workspaceRoot, 'frontend');
  writeTree(source, 'managed workspace');
  const published = publishFrontendSnapshot({
    sourceRoot: source,
    cacheRoot: managed.cacheRoot,
    retentionLeaseId: managed.leaseId,
  });
  assert.equal(fs.readFileSync(path.join(published.snapshotRoot, 'index.html'), 'utf8'), '<main>managed workspace</main>');
  releaseManagedFrontendWorkspace(workspace);
  assert.equal(fs.readdirSync(path.join(managed.cacheRoot, '.osg-frontend-workspaces')).length, 0);
  assert.throws(
    () => releaseManagedFrontendWorkspace(workspace),
    /must contain valid JSON|no such file|ENOENT/u,
  );
});

test('a new exact lease recovers a journalled workspace from an older lease but not unowned bytes', (context) => {
  const root = temporaryRoot(context);
  const managed = managedFrontendLane(root);
  const first = publishFrontendSnapshot({
    sourceRoot: (() => {
      const source = path.join(root, 'source');
      writeTree(source);
      return source;
    })(),
    cacheRoot: managed.cacheRoot,
    retentionLeaseId: managed.leaseId,
  });
  assert.ok(first.snapshotHash);
  const oldWorkspaceId = 'f'.repeat(32);
  const oldLeaf = `workspace-${oldWorkspaceId}`;
  const workspacesRoot = path.join(managed.cacheRoot, '.osg-frontend-workspaces');
  fs.mkdirSync(path.join(workspacesRoot, oldLeaf));
  fs.writeFileSync(path.join(workspacesRoot, oldLeaf, 'partial.txt'), 'old interrupted build');
  writeJson(path.join(workspacesRoot, `${oldLeaf}.json`), {
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId: managed.rootId,
    leaseId: '9'.repeat(32),
    processId: 9999,
    workspaceId: oldWorkspaceId,
    directoryLeaf: oldLeaf,
  });
  const workspace = createManagedFrontendWorkspace({
    cacheRoot: managed.cacheRoot,
    retentionLeaseId: managed.leaseId,
  });
  assert.equal(fs.existsSync(path.join(workspacesRoot, oldLeaf)), false);
  assert.equal(fs.existsSync(path.join(workspacesRoot, `${oldLeaf}.json`)), false);
  releaseManagedFrontendWorkspace(workspace);

  const unknown = path.join(workspacesRoot, `workspace-${'8'.repeat(32)}`);
  fs.mkdirSync(unknown);
  assert.throws(
    () => createManagedFrontendWorkspace({
      cacheRoot: managed.cacheRoot,
      retentionLeaseId: managed.leaseId,
    }),
    /has no ownership journal/u,
  );
  assert.equal(fs.existsSync(unknown), true);
});
