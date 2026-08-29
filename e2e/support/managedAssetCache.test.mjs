import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import test from 'node:test';

import { prepareManagedAssetCacheForTest } from './managedAssetCache.js';

test('managed fixture caches are ordinary direct children, never nested or redirected', (context) => {
  const assetRoot = mkdtempSync(join(tmpdir(), 'osg-managed-asset-root-'));
  context.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const direct = join(assetRoot, 'fixture');
  assert.equal(prepareManagedAssetCacheForTest({ assetRoot, cacheRoot: direct }), direct);
  assert.equal(existsSync(direct), true);
  assert.throws(
    () => prepareManagedAssetCacheForTest({
      assetRoot,
      cacheRoot: join(assetRoot, 'nested', 'fixture'),
    }),
    /one direct child/u,
  );

  const target = join(assetRoot, 'redirect-target');
  const redirected = join(assetRoot, 'redirected');
  mkdirSync(target);
  symlinkSync(target, redirected, 'junction');
  assert.throws(
    () => prepareManagedAssetCacheForTest({ assetRoot, cacheRoot: redirected }),
    /redirected/u,
  );
});

test('persistent asset acquisition remains supervised, root-bound and freshly lease-checked', () => {
  const source = readFileSync(new URL('./realMedia.js', import.meta.url), 'utf8');
  const sourceSwitch = source.slice(
    source.indexOf('export const ensureSourceSwitchVideo'),
    source.indexOf('const REAL_MEDIA_RECEIPT'),
  );
  assert.match(sourceSwitch, /runSupervisedSync\(\{/u);
  assert.match(sourceSwitch, /ownerProcessId:\s*process\.pid/u);
  assert.match(sourceSwitch, /managedPaths:\s*applicationLease\.managedPaths/u);
  assert.match(sourceSwitch, /windowsHide:\s*true/u);
  assert.match(
    sourceSwitch,
    /sha256File\(temporary\)[\s\S]*?assertLiveE2eAssetLease\(applicationLease\)[\s\S]*?renameSync\(temporary, destination\)/u,
  );
});
