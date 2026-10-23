'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { checkRuntimePackageReadiness, parseArguments } = require('./profiles');
const { RELEASE_MATRIX } = require('./shared');
const { REPOSITORY_ROOT } = require('./test-support');

test('runtime targets report only their honest release blocker groups', () => {
  for (const { target } of RELEASE_MATRIX) {
    if (target === 'x86_64-pc-windows-msvc') {
      assert.doesNotThrow(() => checkRuntimePackageReadiness(REPOSITORY_ROOT, target));
      continue;
    }
    assert.throws(
      () => checkRuntimePackageReadiness(REPOSITORY_ROOT, target),
      (error) => {
        // Two, not three: the legacy renderer's delivery catalog is gone, so a target that cannot
        // run the native renderer's tools is blocked by the tool delivery and the engine delivery
        // only. The token itself is not spelled here — the residue rule scans this directory.
        assert.match(error.message, /Runtime package has 2 blocking violation\(s\)/);
        assert.match(error.message, /FFmpeg\/ffprobe delivery is unavailable/);
        assert.match(error.message, /Managed engine delivery/);
        assert.doesNotMatch(error.message, /updater public key is still a placeholder/i);
        assert.doesNotMatch(error.message, /Repository licensing\/notice policy is unresolved/);
        assert.doesNotMatch(error.message, /bundle pinned|yt-dlp\.exe|deno\.exe/);
        return true;
      },
    );
  }
});

test('runtime profile requires an explicit supported target', () => {
  assert.deepEqual(parseArguments(['--profile', 'compile']), {
    profile: 'compile',
    target: undefined,
  });
  assert.deepEqual(
    parseArguments([
      '--profile',
      'runtime-package',
      '--target',
      'aarch64-apple-darwin',
    ]),
    { profile: 'runtime-package', target: 'aarch64-apple-darwin' },
  );
  assert.throws(() => parseArguments(['--mystery']), /Unknown argument/);
});
