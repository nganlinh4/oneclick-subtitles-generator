import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertInstalledTauriServiceSafety,
  assertTauriServicePackagePin,
  assertTauriServiceSourceSafety,
  patchInstalledTauriService,
  patchTauriServiceSource,
  reviewedTauriServiceSources,
} from './tauriServiceSafetyPatch.mjs';

const E2E_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVICE_ROOT = join(E2E_ROOT, 'node_modules', '@wdio', 'tauri-service');
const LOCKED_RESOLUTION =
  'https://registry.npmjs.org/@wdio/tauri-service/-/tauri-service-1.3.0.tgz';
const LOCKED_INTEGRITY =
  'sha512-CzO7ddZo0gIdwVWDftUbHmDPC74M2ZDwWiucUe1M37/QCNy9y4QEdYbobD8yuL1c9n4dAO+NQzmvC3BUICjl0Q==';

const REVERSE_REPLACEMENTS = Object.freeze([
  Object.freeze([
    [
      '            if (this.browser?.isMultiremote) {',
      '                const mrBrowser = this.browser;',
      '                for (const instanceName of mrBrowser.instances) {',
      '                    const instance = mrBrowser.getInstance(instanceName);',
      '                    if (!instance.sessionId)',
      '                        continue;',
      '                    try {',
      '                        await restoreAllMocks.call({ browser: instance });',
      '                    }',
    ].join('\n'),
    [
      '            if (this.browser?.isMultiremote) {',
      '                const mrBrowser = this.browser;',
      '                for (const instanceName of mrBrowser.instances) {',
      '                    try {',
      '                        await restoreAllMocks.call({ browser: mrBrowser.getInstance(instanceName) });',
      '                    }',
    ].join('\n'),
  ]),
  Object.freeze([
    '            else if (this.browser?.sessionId) {',
    '            else if (this.browser) {',
  ]),
  Object.freeze([
    [
      '        // External-driver diagnostics may resolve or install native driver binaries.',
      '        if (!this.isEmbeddedMode) {',
      '            await this.diagnoseEnvironment(this.appBinaryPath);',
      '        }',
    ].join('\n'),
    [
      '        // Run environment diagnostics',
      '        await this.diagnoseEnvironment(this.appBinaryPath);',
    ].join('\n'),
  ]),
  Object.freeze([
    "    log$7.debug('Using the isolated embedded-provider environment');",
    '    log$7.debug(`Environment: ${JSON.stringify(env, null, 2)}`);',
  ]),
  Object.freeze([
    "        if (!isEmbedded && process.platform === 'win32' && firstResolvedBinaryPath !== undefined) {",
    "        if (process.platform === 'win32' && firstResolvedBinaryPath !== undefined) {",
  ]),
  Object.freeze([
    [
      '        env,',
      "        stdio: ['ignore', 'pipe', 'pipe'],",
      '        detached: false,',
      '        windowsHide: true,',
    ].join('\n'),
    [
      '        env,',
      "        stdio: ['ignore', 'pipe', 'pipe'],",
      '        detached: false,',
    ].join('\n'),
  ]),
  Object.freeze([
    "        log$6.debug('Capabilities supplied (values redacted)');",
    "        log$6.debug('Capabilities:', JSON.stringify(capabilities, null, 2));",
  ]),
  Object.freeze([
    "        log$6.debug('Configuration supplied (values redacted)');",
    "        log$6.debug('Config:', JSON.stringify(config, null, 2));",
  ]),
  Object.freeze([
    "            log$6.debug('Capabilities omitted the application path (values redacted)');",
    '            log$6.debug(`Capabilities structure: ${JSON.stringify(firstCap, null, 2)}`);',
  ]),
  Object.freeze([
    "        log$6.debug('Single driver mode options accepted (values redacted)');",
    '        log$6.debug(`Single driver mode options: ${JSON.stringify(options, null, 2)}`);',
  ]),
  Object.freeze([
    "    log.debug('Tauri service capabilities prepared (values redacted)');",
    "    log.debug('Tauri service capabilities after onPrepare:', JSON.stringify(capabilities, null, 2));",
  ]),
]);

function installedSource(spec) {
  return readFileSync(join(SERVICE_ROOT, spec.relativePath), 'utf8');
}

function upstreamSourceFromPatched(source) {
  let upstream = source;
  for (const [safe, unsafe] of REVERSE_REPLACEMENTS) {
    assert.equal(upstream.split(safe).length - 1, 1, `reviewed replacement missing: ${safe}`);
    upstream = upstream.replace(safe, unsafe);
  }
  return upstream;
}

function supersededSourceFromPatched(source) {
  let superseded = source;
  for (const index of [0, 1, 2]) {
    const [safe, unsafe] = REVERSE_REPLACEMENTS[index];
    assert.equal(superseded.split(safe).length - 1, 1);
    superseded = superseded.replace(safe, unsafe);
  }
  return superseded;
}

function preSessionGuardSourceFromPatched(source) {
  let prior = source;
  for (const index of [0, 1]) {
    const [safe, unsafe] = REVERSE_REPLACEMENTS[index];
    assert.equal(prior.split(safe).length - 1, 1);
    prior = prior.replace(safe, unsafe);
  }
  return prior;
}

function writeFixtureRoot({ unsafe = false, installedVersion = '1.3.0', integrity = LOCKED_INTEGRITY } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'osg-tauri-service-patch-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    devDependencies: { '@wdio/tauri-service': '1.3.0' },
  }), 'utf8');
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    packages: {
      'node_modules/@wdio/tauri-service': {
        version: '1.3.0',
        resolved: LOCKED_RESOLUTION,
        integrity,
      },
    },
  }), 'utf8');
  const serviceRoot = join(root, 'node_modules', '@wdio', 'tauri-service');
  mkdirSync(serviceRoot, { recursive: true });
  writeFileSync(join(serviceRoot, 'package.json'), JSON.stringify({
    name: '@wdio/tauri-service',
    version: installedVersion,
    license: 'MIT',
  }), 'utf8');
  for (const spec of reviewedTauriServiceSources) {
    const path = join(serviceRoot, spec.relativePath);
    mkdirSync(dirname(path), { recursive: true });
    const safeSource = installedSource(spec);
    writeFileSync(path, unsafe ? upstreamSourceFromPatched(safeSource) : safeSource, 'utf8');
  }
  return root;
}

test('the installed service is the exact reviewed archive with both entry points patched', () => {
  assertTauriServicePackagePin();
  assertInstalledTauriServiceSafety();
  for (const spec of reviewedTauriServiceSources) {
    const source = installedSource(spec);
    assert.doesNotMatch(
      source,
      /JSON\.stringify\((?:env|capabilities|config|firstCap|options)\b/u,
      `${spec.flavor} still serializes a secret-bearing object into logs`,
    );
    assert.match(
      source,
      /if \(!this\.isEmbeddedMode\) \{\s*await this\.diagnoseEnvironment\(this\.appBinaryPath\);\s*\}/u,
      `${spec.flavor} lets embedded workers enter external-driver diagnostics`,
    );
  }
});

test('the exact upstream bundles patch safely and a second application is idempotent', () => {
  for (const spec of reviewedTauriServiceSources) {
    const safeSource = installedSource(spec);
    const unsafeSource = upstreamSourceFromPatched(safeSource);
    assert.throws(
      () => assertTauriServiceSourceSafety(unsafeSource, spec),
      /not the reviewed patch/u,
    );
    const first = patchTauriServiceSource(unsafeSource, spec);
    assert.equal(first.changed, true);
    assert.equal(first.source, safeSource);
    const second = patchTauriServiceSource(first.source, spec);
    assert.equal(second.changed, false);
    assert.equal(second.source, safeSource);
  }
});

test('the superseded patch migrates without exposing the external-driver diagnostic path', () => {
  for (const spec of reviewedTauriServiceSources) {
    const safeSource = installedSource(spec);
    const superseded = supersededSourceFromPatched(safeSource);
    assert.throws(
      () => assertTauriServiceSourceSafety(superseded, spec),
      /not the reviewed patch/u,
    );
    const migrated = patchTauriServiceSource(superseded, spec);
    assert.equal(migrated.changed, true);
    assert.equal(migrated.source, safeSource);
    assertTauriServiceSourceSafety(migrated.source, spec);
  }
});

test('the prior safety patch migrates by guarding sessionless teardown', () => {
  for (const spec of reviewedTauriServiceSources) {
    const safeSource = installedSource(spec);
    const prior = preSessionGuardSourceFromPatched(safeSource);
    assert.throws(
      () => assertTauriServiceSourceSafety(prior, spec),
      /not the reviewed patch/u,
    );
    const migrated = patchTauriServiceSource(prior, spec);
    assert.equal(migrated.changed, true);
    assert.equal(migrated.source, safeSource);
    assertTauriServiceSourceSafety(migrated.source, spec);
  }
});

test('source drift fails closed even when all three primary unsafe signatures remain', () => {
  for (const spec of reviewedTauriServiceSources) {
    const unsafeSource = upstreamSourceFromPatched(installedSource(spec));
    const drifted = `${unsafeSource}\n// unreviewed drift`;
    assert.match(drifted, /Environment: \$\{JSON\.stringify\(env/u);
    assert.match(drifted, /await ensureMsEdgeDriver\(/u);
    assert.match(drifted, /detached: false,/u);
    assert.throws(
      () => patchTauriServiceSource(drifted, spec),
      /source drifted before patching/u,
    );
  }
});

test('a clean-install fixture is unsafe before postinstall and exact after it', () => {
  const root = writeFixtureRoot({ unsafe: true });
  try {
    assert.throws(() => assertInstalledTauriServiceSafety(root), /not the reviewed patch/u);
    const first = patchInstalledTauriService(root);
    assert.equal(first.changed, true);
    assertInstalledTauriServiceSafety(root);
    const second = patchInstalledTauriService(root);
    assert.equal(second.changed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed version and package-lock provenance drift both fail closed', () => {
  const wrongVersionRoot = writeFixtureRoot({ installedVersion: '1.3.1' });
  const wrongIntegrityRoot = writeFixtureRoot({ integrity: 'sha512-not-the-reviewed-archive' });
  try {
    assert.throws(
      () => assertInstalledTauriServiceSafety(wrongVersionRoot),
      /not the reviewed 1\.3\.0 MIT package/u,
    );
    assert.throws(
      () => assertInstalledTauriServiceSafety(wrongIntegrityRoot),
      /package-lock provenance/u,
    );
  } finally {
    rmSync(wrongVersionRoot, { recursive: true, force: true });
    rmSync(wrongIntegrityRoot, { recursive: true, force: true });
  }
});

test('postinstall owns the patch and WDIO verifies it before creating an isolated run', () => {
  const packageJson = JSON.parse(readFileSync(join(E2E_ROOT, 'package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts?.postinstall,
    'node support/tauriServiceSafetyPatch.mjs --apply',
  );
  const configSource = readFileSync(join(E2E_ROOT, 'wdio.conf.js'), 'utf8');
  const assertion = configSource.indexOf('assertInstalledTauriServiceSafety();');
  const firstMutation = configSource.indexOf('const runRoot =');
  assert.ok(assertion >= 0, 'WDIO config does not verify the installed service patch');
  assert.ok(firstMutation >= 0, 'WDIO config no longer declares its isolated run root');
  assert.ok(assertion < firstMutation, 'service verification runs after harness state creation');
});
