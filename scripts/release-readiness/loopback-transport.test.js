'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { assertNoLegacyRendererResidue } = require('./legacy-residue');
const {
  assertLoopbackAuditManifest,
  assertNoMissingNativeCapabilities,
  assertNoUnmanagedLocalServices,
} = require('./loopback-transport');
const { REPOSITORY_ROOT, temporaryRoot, writeFile } = require('./test-support');

test('test-only support modules may hold loopback fixtures, but production may not import them', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-test-support-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  writeFile(root, 'src/platform/renderServiceTestFixtures.js', "export const ORIGIN = 'http://127.0.0.1:3031';");
  writeFile(root, 'src/platform/renderService.test.js', "import { ORIGIN } from './renderServiceTestFixtures';");
  assert.doesNotThrow(() => assertNoUnmanagedLocalServices(root));
  writeFile(root, 'src/platform/renderService.js', "import { ORIGIN } from './renderServiceTestFixtures';");
  assert.throws(
    () => assertNoUnmanagedLocalServices(root),
    /Production frontend imports test-only support modules: src\/platform\/renderService\.js/,
  );
});

test('production rejects every unmanaged loopback endpoint', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-render-delivery-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  writeFile(
    root,
    'src/utils/videoRendererClient.js',
    "export const RENDERER_BASE_URL = 'http://localhost:3033';",
  );
  assert.throws(
    () => assertNoUnmanagedLocalServices(root),
    /Production frontend still contains unmanaged loopback service endpoints/,
  );
  fs.rmSync(path.join(root, 'src/utils/videoRendererClient.js'));
  writeFile(
    root,
    'src/utils/ipv6Renderer.js',
    "export const RENDERER_BASE_URL = 'http://[::1]:3033';",
  );
  assert.throws(
    () => assertNoUnmanagedLocalServices(root),
    /Production frontend still contains unmanaged loopback service endpoints/,
  );
  fs.rmSync(path.join(root, 'src/utils/ipv6Renderer.js'));
  writeFile(
    root,
    'src/utils/publicRenderer.js',
    "export const RENDERER_BASE_URL = 'https://localhost.example.test';",
  );
  assert.doesNotThrow(() => assertNoUnmanagedLocalServices(root));
  fs.rmSync(path.join(root, 'src/utils/publicRenderer.js'));
  writeFile(
    root,
    'src/utils/wrappedOrigin.js',
    [
      "import { guardBrowserOnlyServiceOrigin } from '../platform/browserOnlyService';",
      "export const SERVER = guardBrowserOnlyServiceOrigin('http://localhost:3031');",
    ].join('\n'),
  );
  assert.throws(
    () => assertNoUnmanagedLocalServices(root),
    /Production frontend still contains unmanaged loopback service endpoints/,
  );
  fs.rmSync(path.join(root, 'src/utils/wrappedOrigin.js'));
  writeFile(
    root,
    'src/platform/mediaCapability.js',
    'const PLAYBACK = /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/asset\\//;',
  );
  assert.doesNotThrow(() => assertNoUnmanagedLocalServices(root));
});

test('the production transport audit is native-only and has no capability blockers', () => {
  const audit = assertLoopbackAuditManifest(REPOSITORY_ROOT);
  assert.equal(audit.schemaVersion, 2);
  assert.equal(audit.productionPolicy, 'native-only');
  assert.equal(audit.artifactGate, 'scripts/check-production-transport.js');
  assert.ok(audit.reviewedCompatibilitySources.length <= 3);
  assert.deepEqual(audit.missingCapabilities, []);
  assert.doesNotThrow(() => assertNoMissingNativeCapabilities(REPOSITORY_ROOT));
});

test('the deleted browser render path cannot come back through any scanned source', (context) => {
  const root = temporaryRoot(context, 'osg-legacy-residue-');
  // Assembled from halves so this test file is not itself an offender.
  const token = ['re', 'motion'].join('');
  writeFile(root, 'src/render.js', 'export const renderer = "native";\n');
  writeFile(root, 'docs/history.md', `${token}\n`);
  assert.doesNotThrow(() => assertNoLegacyRendererResidue(root));

  writeFile(root, 'scripts/build.js', `require('@${token}/renderer');\n`);
  assert.throws(
    () => assertNoLegacyRendererResidue(root),
    /deleted browser render path is reachable again from 1 file\(s\): scripts\/build\.js/,
  );
});

test('the repository carries no legacy renderer residue', () => {
  assert.doesNotThrow(() => assertNoLegacyRendererResidue(REPOSITORY_ROOT));
});
