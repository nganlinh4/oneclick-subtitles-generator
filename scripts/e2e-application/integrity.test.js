'use strict';

// Corruption, extra or hard-linked bytes, and path-boundary refusals.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  readAndVerifyE2eApplicationReceipt,
  resolveAbsoluteInput,
} = require('../e2e-application-publication');
const {
  publishE2eApplication,
  temporaryRoot,
  verbatimPath,
  writeFile,
  writeProfile,
} = require('./test-fixtures');

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
