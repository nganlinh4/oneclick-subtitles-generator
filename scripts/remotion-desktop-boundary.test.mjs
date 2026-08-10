import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  PINNED_REMOTION_VERSION,
  createRemotionDesktopBoundaryPlugin,
  resolvePinnedRemotionInstallation,
  rewriteExactRemotionTransportPatterns,
  rewritePinnedRemotionEsm,
} from './remotion-desktop-boundary.mjs';

const installation = resolvePinnedRemotionInstallation();
const mainModule = installation.modules.find(({ entrypoint }) => entrypoint.endsWith('/index.mjs'));
const noReactModule = installation.modules.find(({ entrypoint }) => entrypoint.endsWith('/no-react.mjs'));

test('rewrites only the pinned transports in both Remotion ESM entrypoints', () => {
  const rewritten = rewritePinnedRemotionEsm(
    mainModule.source,
    installation.version,
    mainModule.entrypoint,
  );
  const noReactRewritten = rewritePinnedRemotionEsm(
    noReactModule.source,
    installation.version,
    noReactModule.entrypoint,
  );

  assert.equal(rewritten.includes('http://localhost:3000'), false);
  assert.equal(rewritten.includes('window.remotion_proxyPort'), false);
  assert.equal(noReactRewritten.includes('window.remotion_proxyPort'), false);
  assert.match(rewritten, /\?\? "file:\/\/\/"/);
  assert.match(rewritten, /OffthreadVideo proxy transport is unavailable/);
  assert.match(noReactRewritten, /OffthreadVideo proxy transport is unavailable/);
  assert.equal(
    rewritten.length,
    mainModule.source.length -
      'http://localhost:3000'.length +
      'file:///'.length -
      '  return `http://localhost:${window.remotion_proxyPort}/proxy?src=${encodeURIComponent(getAbsoluteSrc(src))}&time=${encodeURIComponent(Math.max(0, currentTime))}&transparent=${String(transparent)}&toneMapped=${String(toneMapped)}`;'.length +
      '  throw new Error("Remotion OffthreadVideo proxy transport is unavailable in the desktop preview");'.length,
  );
});

test('fails closed on Remotion version or source drift', () => {
  assert.throws(
    () => rewritePinnedRemotionEsm(mainModule.source, '4.0.508', mainModule.entrypoint),
    /Unsupported Remotion version/,
  );
  assert.throws(
    () => rewritePinnedRemotionEsm(
      `${noReactModule.source}\n`,
      PINNED_REMOTION_VERSION,
      noReactModule.entrypoint,
    ),
    /source integrity mismatch/,
  );
});

test('fails closed when either exact source pattern is missing or duplicated', () => {
  const fallback = 'http://localhost:3000';
  assert.throws(
    () => rewriteExactRemotionTransportPatterns(
      mainModule.source.replace(fallback, 'file:///'),
      mainModule.entrypoint,
    ),
    /video-fragment fallback pattern must occur exactly once; found 0/,
  );
  assert.throws(
    () => rewriteExactRemotionTransportPatterns(
      `${noReactModule.source}\n${noReactModule.source}`,
      noReactModule.entrypoint,
    ),
    /OffthreadVideo proxy pattern must occur exactly once; found 2/,
  );
  assert.throws(
    () => rewriteExactRemotionTransportPatterns(mainModule.source, 'dist/esm/changed.mjs'),
    /Unsupported Remotion ESM entrypoint/,
  );
  assert.throws(
    () => rewritePinnedRemotionEsm(mainModule.source, installation.version, 'dist/esm/changed.mjs'),
    /Unsupported Remotion ESM entrypoint/,
  );
  assert.throws(
    () => rewriteExactRemotionTransportPatterns(
      `${mainModule.source}\n${mainModule.source}`,
      mainModule.entrypoint,
    ),
    /video-fragment fallback pattern must occur exactly once; found 2/,
  );
});

test('build plugin transforms only the exact installed module and requires one visit', () => {
  const plugin = createRemotionDesktopBoundaryPlugin();
  assert.equal(plugin.apply, 'build');
  plugin.buildStart();
  assert.equal(plugin.transform('export default 1', `${mainModule.modulePath}.lookalike`), null);

  for (const module of installation.modules) {
    const result = plugin.transform(
      readFileSync(module.modulePath, 'utf8'),
      `${module.modulePath}?commonjs-entry`,
    );
    assert.equal(result.code.includes('http://localhost'), false);
  }
  plugin.generateBundle();

  assert.throws(
    () => plugin.transform(mainModule.source, mainModule.modulePath),
    /transformed more than once/,
  );
});

test('build plugin fails if bundling bypasses the pinned module', () => {
  const plugin = createRemotionDesktopBoundaryPlugin();
  plugin.buildStart();
  assert.throws(
    () => plugin.generateBundle(),
    /must each be transformed exactly once; missing dist\/esm\/index.mjs, dist\/esm\/no-react.mjs/,
  );
});
