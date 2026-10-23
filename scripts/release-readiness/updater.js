'use strict';

// The signed updater: HTTPS-only endpoints on the dedicated native channel, a real minisign key,
// no guest updater permissions, reviewed Windows install mode, and an isolated CI fixture.

const fs = require('node:fs');
const path = require('node:path');

const {
  REPOSITORY_ROOT,
  TAURI_CONFIG_PATH,
  TAURI_DIRECTORY,
  invariant,
  readJson,
  readText,
  toRepositoryPath,
  walkFiles,
} = require('./shared');
const { assertUpdaterFixtureSeamsAreCompiledOut } = require('./harness-seams');

const UPDATER_PUBLIC_KEY_PATH = `${TAURI_DIRECTORY}/updater-public-key.txt`;
const UPDATER_WINDOWS_INSTALL_MODE = 'passive';
const UPDATER_DANGEROUS_KEYS = [
  [
    'dangerousAcceptInvalidCerts',
    'Tauri updater must never accept invalid TLS certificates in release packages',
  ],
  [
    'dangerousAcceptInvalidHostnames',
    'Tauri updater must never accept invalid TLS hostnames in release packages',
  ],
];
const UPDATER_REVIEWED_KEYS = new Set([
  'endpoints',
  'pubkey',
  'windows',
  'dangerousInsecureTransportProtocol',
  ...UPDATER_DANGEROUS_KEYS.map(([key]) => key),
]);
const UPDATER_REVIEWED_WINDOWS_KEYS = new Set(['installMode', 'installerArgs']);

function decodeUpdaterPublicKey(value) {
  invariant(
    typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value),
    'Updater public key must be canonical base64 from the Tauri signer',
  );
  const decoded = Buffer.from(value, 'base64');
  invariant(
    decoded.length > 0 && decoded.toString('base64') === value,
    'Updater public key must be canonical base64 from the Tauri signer',
  );
  const minisign = decoded.toString('utf8');
  invariant(
    !minisign.includes('\uFFFD'),
    'Updater public key must decode to a UTF-8 minisign public key',
  );
  const lines = minisign.trim().split(/\r?\n/);
  invariant(
    lines.length === 2 && /^untrusted comment: .*minisign public key/i.test(lines[0]),
    'Updater public key must decode to the two-line minisign public-key format',
  );
  invariant(
    /^[A-Za-z0-9+/]{56}$/.test(lines[1]),
    'Updater public key must contain one exact minisign key line',
  );
  const keyBytes = Buffer.from(lines[1], 'base64');
  invariant(
    keyBytes.length === 42 && keyBytes[0] === 0x45 && keyBytes[1] === 0x64,
    'Updater public key must contain a valid Ed25519 minisign key envelope',
  );
  invariant(
    new Set(keyBytes.subarray(2)).size > 1,
    'Updater public key may not contain placeholder key material',
  );
  return value;
}

function assertNoGuestUpdaterPermissions(rootDirectory) {
  const capabilityDirectory = path.join(rootDirectory, TAURI_DIRECTORY, 'capabilities');
  const capabilityFiles = walkFiles(
    capabilityDirectory,
    (candidate) => candidate.endsWith('.json'),
  );
  invariant(capabilityFiles.length > 0, 'Tauri must declare at least one capability file');
  for (const capabilityFile of capabilityFiles) {
    const relativePath = toRepositoryPath(rootDirectory, capabilityFile);
    const capability = readJson(rootDirectory, relativePath);
    const permissions = capability && capability.permissions;
    invariant(Array.isArray(permissions), `${relativePath} must declare a permissions array`);
    const guestUpdaterPermissions = permissions.filter(
      (permission) => typeof permission === 'string' && /^updater(?::|$)/i.test(permission),
    );
    invariant(
      guestUpdaterPermissions.length === 0,
      `${relativePath} must not grant updater guest permissions: ${guestUpdaterPermissions.join(', ')}`,
    );
  }
}

function assertUpdaterTransportAndInstallMode(updater) {
  for (const [key, message] of UPDATER_DANGEROUS_KEYS) {
    invariant(updater[key] !== true, message);
  }
  const unreviewedKeys = Object.keys(updater)
    .filter((key) => !UPDATER_REVIEWED_KEYS.has(key));
  invariant(
    unreviewedKeys.length === 0,
    `Tauri updater declares unreviewed keys: ${unreviewedKeys.join(', ')}`,
  );

  const windows = updater.windows;
  invariant(
    windows && typeof windows === 'object' && !Array.isArray(windows),
    'Tauri updater must pin its reviewed Windows install behaviour',
  );
  const unreviewedWindowsKeys = Object.keys(windows)
    .filter((key) => !UPDATER_REVIEWED_WINDOWS_KEYS.has(key));
  invariant(
    unreviewedWindowsKeys.length === 0,
    `Tauri updater windows declares unreviewed keys: ${unreviewedWindowsKeys.join(', ')}`,
  );
  invariant(
    windows.installMode === UPDATER_WINDOWS_INSTALL_MODE,
    `Tauri updater windows.installMode must stay ${UPDATER_WINDOWS_INSTALL_MODE}`,
  );
  invariant(
    windows.installerArgs === undefined
      || (Array.isArray(windows.installerArgs) && windows.installerArgs.length === 0),
    'Tauri updater windows.installerArgs must stay empty so no unreviewed installer flag is passed',
  );
}

function assertUpdaterReleaseConfiguration(rootDirectory = REPOSITORY_ROOT) {
  const config = readJson(rootDirectory, TAURI_CONFIG_PATH);
  invariant(
    config.bundle && config.bundle.createUpdaterArtifacts === true,
    'Tauri bundle.createUpdaterArtifacts must be true for signed v2 updater artifacts',
  );
  const updater = config.plugins && config.plugins.updater;
  invariant(updater && typeof updater === 'object' && !Array.isArray(updater),
    'Tauri must configure the signed updater plugin');
  invariant(
    updater.dangerousInsecureTransportProtocol !== true,
    'Tauri updater must never allow insecure transport in release packages',
  );
  assertUpdaterTransportAndInstallMode(updater);
  invariant(
    Array.isArray(updater.endpoints) && updater.endpoints.length > 0,
    'Tauri updater must declare at least one HTTPS latest.json endpoint',
  );
  const endpoints = new Set();
  for (const rawEndpoint of updater.endpoints) {
    invariant(typeof rawEndpoint === 'string' && rawEndpoint.length <= 2_048,
      'Tauri updater endpoints must be bounded URL strings');
    invariant(!endpoints.has(rawEndpoint), `Tauri updater repeats endpoint ${rawEndpoint}`);
    endpoints.add(rawEndpoint);
    const substituted = rawEndpoint.replace(
      /\{\{(?:current_version|target|arch)}}/g,
      'release-value',
    );
    invariant(!substituted.includes('{{'), `Tauri updater endpoint has an unsupported variable: ${rawEndpoint}`);
    let endpoint;
    try {
      endpoint = new URL(substituted);
    } catch {
      throw new Error(`Tauri updater endpoint is invalid: ${rawEndpoint}`);
    }
    invariant(endpoint.protocol === 'https:', `Tauri updater endpoint must use HTTPS: ${rawEndpoint}`);
    invariant(!endpoint.username && !endpoint.password,
      `Tauri updater endpoint may not contain credentials: ${rawEndpoint}`);
    invariant(!endpoint.search && !endpoint.hash,
      `Tauri updater endpoint may not contain a query or fragment: ${rawEndpoint}`);
    // A JSON manifest, and specifically NOT one called `latest.json`.
    //
    // This rule used to require exactly that name, which is what pointed the updater at a file the
    // legacy Electron release also publishes under `releases/latest`. Requiring a `.json` manifest
    // keeps the shape guarantee; forbidding that one name keeps the channels apart.
    invariant(endpoint.pathname.endsWith('.json'),
      `Tauri updater endpoint must resolve to a JSON manifest: ${rawEndpoint}`);
    invariant(!endpoint.pathname.endsWith('/latest.json'),
      `Tauri updater endpoint must not be latest.json, which the legacy release also publishes: ${rawEndpoint}`);
  }

  const keyPath = path.join(rootDirectory, UPDATER_PUBLIC_KEY_PATH);
  invariant(fs.existsSync(keyPath), `Updater public key is missing: ${UPDATER_PUBLIC_KEY_PATH}`);
  const keyMetadata = fs.lstatSync(keyPath);
  invariant(keyMetadata.isFile() && !keyMetadata.isSymbolicLink(),
    'Updater public key must be a regular repository file');
  const publicKey = readText(rootDirectory, UPDATER_PUBLIC_KEY_PATH).trim();
  invariant(publicKey !== 'UNCONFIGURED' && !/placeholder|changeme/i.test(publicKey),
    'Updater public key is still a placeholder');
  decodeUpdaterPublicKey(publicKey);
  invariant(
    updater.pubkey === '' || updater.pubkey === publicKey,
    'Tauri updater config public key must be empty for the reviewed Rust override or match it exactly',
  );
  assertNoGuestUpdaterPermissions(rootDirectory);
  return { endpointCount: endpoints.size };
}

function assertNativeUpdateChannel(config) {
  // Native updates are independent of GitHub's repository-wide Latest selection.
  // Only this channel's metadata is mutable; its signed installers live on versioned releases.
  const updaterManifestName = 'osg-desktop-updater-v2.json';
  invariant(JSON.stringify(config.plugins?.updater?.endpoints) === JSON.stringify([
    `https://raw.githubusercontent.com/nganlinh4/oneclick-subtitles-generator/app-update-feed/${updaterManifestName}`,
  ]), 'Production updater endpoint must remain the dedicated native stable channel, independent of GitHub Latest');
  invariant(
    !config.plugins.updater.endpoints.some((endpoint) => endpoint.endsWith('/latest.json')),
    'Production updater must not read a manifest named latest.json; the legacy release publishes one',
  );
}

/** The body of `fn name(...) { ... }`, or null. Braces inside string literals are ignored. */
function extractRustFunctionBody(source, name) {
  const signature = new RegExp(String.raw`\bfn\s+${name}\s*\(`, 'u').exec(source);
  if (signature === null) return null;
  const bodyStart = source.indexOf('{', signature.index);
  if (bodyStart < 0) return null;
  let depth = 0;
  let quoted = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '\\') index += 1;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  return null;
}

/**
 * build.rs refuses to compile the signed-updater fixture outside the isolated GitHub workflow.
 * The scope check must be the first statement of `main`, so no earlier step can run without it.
 */
function assertUpdaterFixtureBuildScope(build) {
  const mainBody = extractRustFunctionBody(build, 'main');
  invariant(
    mainBody !== null && /^\s*verify_ci_updater_fixture_scope\(\);/u.test(mainBody),
    'Updater fixture build scope must run first and unconditionally, before managed delivery and the Tauri build',
  );
  const scopeBody = extractRustFunctionBody(build, 'verify_ci_updater_fixture_scope');
  invariant(scopeBody !== null, 'Updater fixture build scope must remain a standalone build-script function');
  const debugExemption = String.raw`if\s+std::env::var_os\("CARGO_FEATURE_CI_UPDATER_FIXTURE"\)\.is_none\(\)\s*\|\|\s*matches!\(\s*std::env::var\("PROFILE"\)\.as_deref\(\),\s*Ok\("debug"\)\s*\)\s*\{\s*return;\s*\}`;
  invariant(
    new RegExp(debugExemption, 'u').test(scopeBody),
    'Updater fixture build scope must exempt only Cargo debug builds, not custom nonshipping profiles',
  );
  const githubActionsAssertion = String.raw`assert_eq!\(\s*std::env::var\("GITHUB_ACTIONS"\)\.as_deref\(\),\s*Ok\("true"\),\s*"(?:[^"\\]|\\.)*"\s*\);`;
  const explicitOptInAssertion = String.raw`assert_eq!\(\s*std::env::var\("OSG_ENABLE_SIGNED_UPDATER_FIXTURE"\)\.as_deref\(\),\s*Ok\("1"\),\s*"(?:[^"\\]|\\.)*"\s*\);`;
  invariant(
    new RegExp(
      String.raw`^\s*${debugExemption}\s*${githubActionsAssertion}\s*${explicitOptInAssertion}\s*$`,
      'u',
    ).test(scopeBody),
    'Updater fixture build scope must require GITHUB_ACTIONS == "true" and then '
      + 'OSG_ENABLE_SIGNED_UPDATER_FIXTURE == "1" as unconditional top-level assertions',
  );
}

function assertUpdaterFixtureIsolation(rootDirectory = REPOSITORY_ROOT) {
  const cargo = readText(rootDirectory, `${TAURI_DIRECTORY}/Cargo.toml`);
  invariant(/^ci-updater-fixture\s*=\s*\[\]\s*$/m.test(cargo),
    'Desktop Cargo features must declare the isolated updater fixture');
  assertUpdaterFixtureBuildScope(readText(rootDirectory, `${TAURI_DIRECTORY}/build.rs`));
  invariant(
    assertUpdaterFixtureSeamsAreCompiledOut(rootDirectory) > 0,
    'The updater fixture seam guard found nothing to check',
  );
  assertNativeUpdateChannel(readJson(rootDirectory, TAURI_CONFIG_PATH));
}

module.exports = {
  assertNativeUpdateChannel,
  assertUpdaterFixtureBuildScope,
  assertUpdaterFixtureIsolation,
  assertUpdaterReleaseConfiguration,
};
