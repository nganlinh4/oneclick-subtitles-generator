import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* global console, process */

const SERVICE_NAME = '@wdio/tauri-service';
const SERVICE_VERSION = '1.3.0';
const LOCKED_RESOLUTION =
  'https://registry.npmjs.org/@wdio/tauri-service/-/tauri-service-1.3.0.tgz';
const LOCKED_INTEGRITY =
  'sha512-CzO7ddZo0gIdwVWDftUbHmDPC74M2ZDwWiucUe1M37/QCNy9y4QEdYbobD8yuL1c9n4dAO+NQzmvC3BUICjl0Q==';

const UNSAFE_ENVIRONMENT_LOG =
  '    log$7.debug(`Environment: ${JSON.stringify(env, null, 2)}`);';
const SAFE_ENVIRONMENT_LOG =
  "    log$7.debug('Using the isolated embedded-provider environment');";
const UNSAFE_EDGE_DRIVER_GUARD =
  "        if (process.platform === 'win32' && firstResolvedBinaryPath !== undefined) {";
const SAFE_EDGE_DRIVER_GUARD =
  "        if (!isEmbedded && process.platform === 'win32' && firstResolvedBinaryPath !== undefined) {";
const UNSAFE_APP_SPAWN_OPTIONS = [
  '        env,',
  "        stdio: ['ignore', 'pipe', 'pipe'],",
  '        detached: false,',
].join('\n');
const SAFE_APP_SPAWN_OPTIONS = `${UNSAFE_APP_SPAWN_OPTIONS}\n        windowsHide: true,`;
const UNSAFE_WORKER_DIAGNOSTICS = [
  '        // Run environment diagnostics',
  '        await this.diagnoseEnvironment(this.appBinaryPath);',
].join('\n');
const SAFE_WORKER_DIAGNOSTICS = [
  '        // External-driver diagnostics may resolve or install native driver binaries.',
  '        if (!this.isEmbeddedMode) {',
  '            await this.diagnoseEnvironment(this.appBinaryPath);',
  '        }',
].join('\n');
const SESSIONLESS_MOCK_RESTORE = [
  '            if (this.browser?.isMultiremote) {',
  '                const mrBrowser = this.browser;',
  '                for (const instanceName of mrBrowser.instances) {',
  '                    try {',
  '                        await restoreAllMocks.call({ browser: mrBrowser.getInstance(instanceName) });',
  '                    }',
].join('\n');
const GUARDED_MOCK_RESTORE = [
  '            if (this.browser?.isMultiremote) {',
  '                const mrBrowser = this.browser;',
  '                for (const instanceName of mrBrowser.instances) {',
  '                    const instance = mrBrowser.getInstance(instanceName);',
  '                    if (!instance.sessionId)',
  '                        continue;',
  '                    try {',
  '                        await restoreAllMocks.call({ browser: instance });',
  '                    }',
].join('\n');
const REPEATED_FOCUS_SUPPRESSION = [
  'function suppressActiveWindowFocus(browser) {',
  "    userSwitchedWindowCache.add(browser.sessionId || 'default');",
  '}',
].join('\n');
const TRANSITION_FOCUS_SUPPRESSION = [
  'function suppressActiveWindowFocus(browser) {',
  "    const sessionKey = browser.sessionId || 'default';",
  '    if (userSwitchedWindowCache.has(sessionKey)) {',
  '        return;',
  '    }',
  '    userSwitchedWindowCache.add(sessionKey);',
  "    log$5.debug('Skipping auto-focus: user has explicitly switched windows');",
  '}',
].join('\n');
const REPEATED_FOCUS_CACHE_HIT = [
  "    if (userSwitchedWindowCache.has(browser.sessionId || 'default')) {",
  "        log$5.debug('Skipping auto-focus: user has explicitly switched windows');",
  '        return;',
  '    }',
].join('\n');
const SILENT_FOCUS_CACHE_HIT = [
  "    if (userSwitchedWindowCache.has(browser.sessionId || 'default')) {",
  '        return;',
  '    }',
].join('\n');
const SECRET_BEARING_LOG_REPLACEMENTS = Object.freeze([
  Object.freeze({
    description: 'constructor capability dump',
    from: "        log$6.debug('Capabilities:', JSON.stringify(capabilities, null, 2));",
    to: "        log$6.debug('Capabilities supplied (values redacted)');",
  }),
  Object.freeze({
    description: 'constructor configuration dump',
    from: "        log$6.debug('Config:', JSON.stringify(config, null, 2));",
    to: "        log$6.debug('Configuration supplied (values redacted)');",
  }),
  Object.freeze({
    description: 'missing-application capability dump',
    from: '            log$6.debug(`Capabilities structure: ${JSON.stringify(firstCap, null, 2)}`);',
    to: "            log$6.debug('Capabilities omitted the application path (values redacted)');",
  }),
  Object.freeze({
    description: 'external-driver option dump',
    from: '        log$6.debug(`Single driver mode options: ${JSON.stringify(options, null, 2)}`);',
    to: "        log$6.debug('Single driver mode options accepted (values redacted)');",
  }),
  Object.freeze({
    description: 'standalone prepared-capability dump',
    from: "    log.debug('Tauri service capabilities after onPrepare:', JSON.stringify(capabilities, null, 2));",
    to: "    log.debug('Tauri service capabilities prepared (values redacted)');",
  }),
]);

const SOURCE_SPECS = Object.freeze([
  Object.freeze({
    flavor: 'esm',
    relativePath: join('dist', 'esm', 'index.js'),
    unsafeSha256: '9f40744cff59af6adfc7d324064de1493aafaa32e88827e1dec5e8f11439b593',
    supersededSafeSha256: '435bb4a102bf06dd4cc0d42db9156c80afb0f1152d4edc4d6d7ce4b64bfe704f',
    preSessionGuardSafeSha256: '6c33a6952109f5c394151b9f9c6fce6c1a8cc1f85a1b00b3fb5593bc6ee01503',
    preFocusLogSafeSha256: '2d266c40ff0bc729e7a130f45e8f1dc3d09d44009f3cf74d99aa0144c7040154',
    safeSha256: 'e6838ab199861e29ae5749136235dd24e2abe34e5ec17d55900b907d25bb3b60',
  }),
  Object.freeze({
    flavor: 'cjs',
    relativePath: join('dist', 'cjs', 'index.js'),
    unsafeSha256: '34c47d9b676c0f73870889c49f8ccc612591f42b9a221c9ec305497ac94bfe10',
    supersededSafeSha256: '473aa18ebbafc46c0b343d0230af283ee2046b1095ad6703f364e2033ba0c10a',
    preSessionGuardSafeSha256: '244568917603cc8f2c9bcd1e2df8a7e7449c68672bbe426f8a77552cffbb6e18',
    preFocusLogSafeSha256: '44eae1da8eccc5698b9718292d2e07a3c2ed074c667f6da1ec76fd10a68c9a0d',
    safeSha256: 'addd4a7aa0827b40ed21e777633f7cb1e8346ed308d69be961e68b2659b40a47',
  }),
]);

const DEFAULT_E2E_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function sha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

function parseJson(path, description) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${description} is missing or invalid: ${error.message}`);
  }
}

function replaceExactlyOnce(source, from, to, description) {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${SERVICE_NAME} ${SERVICE_VERSION} patch drift: expected exactly one ${description}, found ${occurrences}`,
    );
  }
  return source.replace(from, to);
}

export function assertTauriServiceSourceSafety(source, spec) {
  const digest = sha256(source);
  if (digest !== spec.safeSha256) {
    throw new Error(
      `${SERVICE_NAME} ${SERVICE_VERSION} ${spec.flavor} source is not the reviewed patch `
        + `(sha256 ${digest})`,
    );
  }
  if (source.includes(UNSAFE_ENVIRONMENT_LOG)) {
    throw new Error(`${SERVICE_NAME} still logs the complete environment, including E2E authorization`);
  }
  if (/JSON\.stringify\((?:env|capabilities|config|firstCap|options)\b/u.test(source)) {
    throw new Error(`${SERVICE_NAME} still logs a secret-bearing environment or capability object`);
  }
  if (source.includes(UNSAFE_EDGE_DRIVER_GUARD)) {
    throw new Error(`${SERVICE_NAME} still runs Edge-driver management for the embedded provider`);
  }
  const edgeDriverCalls = source.match(/await ensureMsEdgeDriver\(/gu)?.length ?? 0;
  if (edgeDriverCalls !== 1) {
    throw new Error(`${SERVICE_NAME} has an unexpected number of Edge-driver call sites: ${edgeDriverCalls}`);
  }
  if (!source.includes(SAFE_EDGE_DRIVER_GUARD)) {
    throw new Error(`${SERVICE_NAME} does not exclude the embedded provider from Edge-driver management`);
  }
  if (source.includes(SESSIONLESS_MOCK_RESTORE) || !source.includes(GUARDED_MOCK_RESTORE)) {
    throw new Error(`${SERVICE_NAME} still restores mocks through a sessionless browser`);
  }
  if (source.includes('            else if (this.browser) {')) {
    throw new Error(`${SERVICE_NAME} still restores single-browser mocks without a session id`);
  }
  if (!source.includes('            else if (this.browser?.sessionId) {')) {
    throw new Error(`${SERVICE_NAME} does not guard single-browser mock restoration by session id`);
  }
  if (!source.includes(TRANSITION_FOCUS_SUPPRESSION) || source.includes(REPEATED_FOCUS_CACHE_HIT)) {
    throw new Error(`${SERVICE_NAME} repeats the explicit-window focus diagnostic on every command`);
  }
  const focusSuppressionLogs = source.match(
    /Skipping auto-focus: user has explicitly switched windows/gu,
  )?.length ?? 0;
  if (focusSuppressionLogs !== 1 || !source.includes(SILENT_FOCUS_CACHE_HIT)) {
    throw new Error(`${SERVICE_NAME} does not log focus suppression once at its state transition`);
  }
  const diagnosticCalls = source.match(/await this\.diagnoseEnvironment\(this\.appBinaryPath\);/gu)?.length ?? 0;
  if (diagnosticCalls !== 1 || !source.includes(SAFE_WORKER_DIAGNOSTICS)) {
    throw new Error(`${SERVICE_NAME} does not exclude embedded workers from external-driver diagnostics`);
  }
  const spawnStart = source.indexOf('function spawnTauriApp(');
  const spawnEnd = source.indexOf('\n}', spawnStart);
  const spawnSource = source.slice(spawnStart, spawnEnd);
  if (spawnStart < 0 || spawnEnd < 0 || !spawnSource.includes(SAFE_APP_SPAWN_OPTIONS)) {
    throw new Error(`${SERVICE_NAME} does not hide the embedded application child process`);
  }
}

export function patchTauriServiceSource(source, spec) {
  const digest = sha256(source);
  if (digest === spec.safeSha256) {
    assertTauriServiceSourceSafety(source, spec);
    return Object.freeze({ source, changed: false });
  }
  if (digest !== spec.unsafeSha256
      && digest !== spec.supersededSafeSha256
      && digest !== spec.preSessionGuardSafeSha256
      && digest !== spec.preFocusLogSafeSha256) {
    throw new Error(
      `${SERVICE_NAME} ${SERVICE_VERSION} ${spec.flavor} source drifted before patching `
        + `(sha256 ${digest}); refusing a best-effort rewrite`,
    );
  }

  let patched = source;
  if (digest === spec.unsafeSha256) {
    patched = replaceExactlyOnce(
      patched,
      UNSAFE_ENVIRONMENT_LOG,
      SAFE_ENVIRONMENT_LOG,
      'full-environment debug log',
    );
    patched = replaceExactlyOnce(
      patched,
      UNSAFE_EDGE_DRIVER_GUARD,
      SAFE_EDGE_DRIVER_GUARD,
      'unconditional Windows Edge-driver guard',
    );
    patched = replaceExactlyOnce(
      patched,
      UNSAFE_APP_SPAWN_OPTIONS,
      SAFE_APP_SPAWN_OPTIONS,
      'embedded application spawn option block',
    );
    for (const replacement of SECRET_BEARING_LOG_REPLACEMENTS) {
      patched = replaceExactlyOnce(
        patched,
        replacement.from,
        replacement.to,
        replacement.description,
      );
    }
  }
  if (digest === spec.unsafeSha256 || digest === spec.supersededSafeSha256) {
    patched = replaceExactlyOnce(
      patched,
      UNSAFE_WORKER_DIAGNOSTICS,
      SAFE_WORKER_DIAGNOSTICS,
      'unguarded worker environment diagnostics',
    );
  }
  if (digest !== spec.preFocusLogSafeSha256) {
    patched = replaceExactlyOnce(
      patched,
      SESSIONLESS_MOCK_RESTORE,
      GUARDED_MOCK_RESTORE,
      'sessionless multiremote mock restoration',
    );
    patched = replaceExactlyOnce(
      patched,
      '            else if (this.browser) {',
      '            else if (this.browser?.sessionId) {',
      'sessionless single-browser mock restoration',
    );
  }
  patched = replaceExactlyOnce(
    patched,
    REPEATED_FOCUS_SUPPRESSION,
    TRANSITION_FOCUS_SUPPRESSION,
    'unbounded focus-suppression diagnostic',
  );
  patched = replaceExactlyOnce(
    patched,
    REPEATED_FOCUS_CACHE_HIT,
    SILENT_FOCUS_CACHE_HIT,
    'per-command focus-suppression diagnostic',
  );
  assertTauriServiceSourceSafety(patched, spec);
  return Object.freeze({ source: patched, changed: true });
}

export function assertTauriServicePackagePin(e2eRoot = DEFAULT_E2E_ROOT) {
  const packageJson = parseJson(join(e2eRoot, 'package.json'), 'E2E package.json');
  if (packageJson.devDependencies?.[SERVICE_NAME] !== SERVICE_VERSION) {
    throw new Error(`${SERVICE_NAME} must remain pinned exactly to ${SERVICE_VERSION}`);
  }

  const packageLock = parseJson(join(e2eRoot, 'package-lock.json'), 'E2E package-lock.json');
  const locked = packageLock.packages?.[`node_modules/${SERVICE_NAME}`];
  if (
    locked?.version !== SERVICE_VERSION
    || locked?.resolved !== LOCKED_RESOLUTION
    || locked?.integrity !== LOCKED_INTEGRITY
  ) {
    throw new Error(`${SERVICE_NAME} package-lock provenance does not match the reviewed archive`);
  }
}

function installedServicePaths(e2eRoot) {
  const serviceRoot = join(e2eRoot, 'node_modules', '@wdio', 'tauri-service');
  return Object.freeze({
    serviceRoot,
    packagePath: join(serviceRoot, 'package.json'),
    sources: SOURCE_SPECS.map((spec) => Object.freeze({
      spec,
      path: join(serviceRoot, spec.relativePath),
    })),
  });
}

function assertInstalledPackageIdentity(paths) {
  const installedPackage = parseJson(paths.packagePath, `installed ${SERVICE_NAME} package.json`);
  if (
    installedPackage.name !== SERVICE_NAME
    || installedPackage.version !== SERVICE_VERSION
    || installedPackage.license !== 'MIT'
  ) {
    throw new Error(`installed ${SERVICE_NAME} is not the reviewed ${SERVICE_VERSION} MIT package`);
  }
}

export function assertInstalledTauriServiceSafety(e2eRoot = DEFAULT_E2E_ROOT) {
  assertTauriServicePackagePin(e2eRoot);
  const paths = installedServicePaths(e2eRoot);
  assertInstalledPackageIdentity(paths);
  for (const { path, spec } of paths.sources) {
    assertTauriServiceSourceSafety(readFileSync(path, 'utf8'), spec);
  }
}

export function patchInstalledTauriService(e2eRoot = DEFAULT_E2E_ROOT) {
  assertTauriServicePackagePin(e2eRoot);
  const paths = installedServicePaths(e2eRoot);
  assertInstalledPackageIdentity(paths);

  // Validate and transform every entry point before writing either one. A drifted CJS bundle must
  // not leave a newly patched ESM bundle beside it (or vice versa).
  const prepared = paths.sources.map(({ path, spec }) => {
    const result = patchTauriServiceSource(readFileSync(path, 'utf8'), spec);
    return Object.freeze({ path, spec, ...result });
  });
  for (const item of prepared) {
    if (item.changed) writeFileSync(item.path, item.source, 'utf8');
  }
  assertInstalledTauriServiceSafety(e2eRoot);
  return Object.freeze({
    changed: prepared.some((item) => item.changed),
    entryPoints: prepared.map((item) => item.spec.flavor),
  });
}

export const reviewedTauriServiceSources = SOURCE_SPECS;

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') {
    throw new Error('usage: node support/tauriServiceSafetyPatch.mjs --apply');
  }
  const result = patchInstalledTauriService();
  console.log(
    `[osg-e2e] ${SERVICE_NAME} ${SERVICE_VERSION} safety patch `
      + `${result.changed ? 'applied' : 'verified'} (${result.entryPoints.join(', ')})`,
  );
}
