#!/usr/bin/env node

// Produces the signed `latest.json` update manifest consumed by the Tauri
// updater plugin. Every artifact is authenticated against the committed
// updater public key before a single byte of the manifest is emitted, so a
// manifest can never advertise an installer this repository did not sign.

const fs = require('node:fs');
const path = require('node:path');

const { BUNDLE_LAYOUTS, assertSafeArtifact, assertUpdaterSignature } = require('./check-release-artifacts');
const { assertAllVersionsMatch, collectRepositoryVersions } = require('./check-version-consistency');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');

// Tauri resolves `{os}-{arch}-{installer}` before `{os}-{arch}`; the suffixed
// key is emitted because it is unambiguous for every bundle this repository
// releases.
const UPDATER_PLATFORMS = Object.freeze({
  'darwin-aarch64-app': Object.freeze({
    target: 'aarch64-apple-darwin',
    bundle: 'app',
    artifactExtension: '.app.tar.gz',
  }),
  'darwin-x86_64-app': Object.freeze({
    target: 'x86_64-apple-darwin',
    bundle: 'app',
    artifactExtension: '.app.tar.gz',
  }),
  'linux-x86_64-appimage': Object.freeze({
    target: 'x86_64-unknown-linux-gnu',
    bundle: 'appimage',
    artifactExtension: '.AppImage',
  }),
  'windows-x86_64-nsis': Object.freeze({
    target: 'x86_64-pc-windows-msvc',
    bundle: 'nsis',
    artifactExtension: '.exe',
  }),
});

const MANIFEST_KEYS = Object.freeze(['version', 'notes', 'pub_date', 'platforms']);
const PLATFORM_ENTRY_KEYS = Object.freeze(['signature', 'url']);
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,127}$/;
const MAX_NOTES_LENGTH = 2000;
const MAX_SIGNATURE_LENGTH = 4096;

const USAGE = `Usage: node scripts/build-updater-manifest.js --bundle-root <dir> --base-url <https url> \\
    --platform <key> [--platform <key>...] --notes <text> [options]

Builds the signed updater manifest (latest.json) for a release.

Required:
  --bundle-root <dir>   Directory holding <target>/release/bundle/<layout> artifact trees.
  --base-url <url>      HTTPS directory the installers are published under.
  --platform <key>      Updater platform to include; repeat for more than one.
  --notes <text>        Release notes recorded in the manifest.

Optional:
  --version <semver>    Manifest version; must equal the repository version.
  --pub-date <rfc3339>  UTC publication timestamp (default: now).
  --output <file>       Write the manifest inside --bundle-root (default: stdout).
  --help                Print this message.

Known platforms: ${Object.keys(UPDATER_PLATFORMS).join(', ')}

Every artifact is located, required to be unique, and cryptographically verified
against apps/desktop/src-tauri/tauri.conf.json before anything is emitted.`;

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const [platformKey, layout] of Object.entries(UPDATER_PLATFORMS)) {
  const bundleLayout = BUNDLE_LAYOUTS[layout.bundle];
  invariant(bundleLayout, `${platformKey} names an unknown bundle layout`);
  invariant(
    bundleLayout.kind !== 'file' || bundleLayout.extension === layout.artifactExtension,
    `${platformKey} disagrees with the released ${layout.bundle} artifact extension`,
  );
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, expectedKeys, label) {
  invariant(isPlainObject(value), `${label} must be an object`);
  const actual = Object.keys(value);
  for (const key of actual) {
    invariant(expectedKeys.includes(key), `${label} has an unexpected key ${JSON.stringify(key)}`);
  }
  for (const key of expectedKeys) {
    invariant(
      Object.prototype.hasOwnProperty.call(value, key),
      `${label} is missing the ${JSON.stringify(key)} key`,
    );
  }
}

function assertPlainText(value, label, { maxLength, allowNewline = false }) {
  invariant(typeof value === 'string', `${label} must be a string`);
  invariant(value.length > 0, `${label} is empty`);
  invariant(value.length <= maxLength, `${label} exceeds ${maxLength} characters`);
  const forbidden = allowNewline
    ? /[\u0000-\u0009\u000b-\u001f\u007f\ufeff]/
    : /[\u0000-\u001f\u007f\ufeff]/;
  invariant(!forbidden.test(value), `${label} contains control characters`);
  return value;
}

function assertCanonicalBase64(value, label) {
  assertPlainText(value, label, { maxLength: MAX_SIGNATURE_LENGTH });
  invariant(
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0,
    `${label} is not canonical base64`,
  );
  invariant(
    Buffer.from(value, 'base64').toString('base64') === value,
    `${label} is not canonical base64`,
  );
  return value;
}

function assertHttpsUrl(value, label) {
  assertPlainText(value, label, { maxLength: 2048 });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  invariant(parsed.protocol === 'https:', `${label} must use https`);
  invariant(parsed.hostname.length > 0, `${label} has no host`);
  invariant(!parsed.username && !parsed.password, `${label} must not embed credentials`);
  invariant(!parsed.hash, `${label} must not carry a fragment`);
  return parsed;
}

function assertPublicationDate(value) {
  assertPlainText(value, 'Manifest pub_date', { maxLength: 40 });
  invariant(RFC3339_UTC_PATTERN.test(value), 'Manifest pub_date must be an RFC 3339 UTC timestamp');
  invariant(Number.isFinite(Date.parse(value)), 'Manifest pub_date is not a real instant');
  return value;
}

/**
 * Validates a manifest description and returns the canonical, frozen manifest.
 * Pure: it never touches the filesystem, the clock, or the environment.
 */
function buildManifest(input, { repositoryVersion } = {}) {
  invariant(
    typeof repositoryVersion === 'string' && SEMVER_PATTERN.test(repositoryVersion),
    'A semantic repository version is required to build the manifest',
  );
  assertExactKeys(input, MANIFEST_KEYS, 'Manifest');

  assertPlainText(input.version, 'Manifest version', { maxLength: 64 });
  invariant(SEMVER_PATTERN.test(input.version), `Manifest version is not a semantic version: ${input.version}`);
  invariant(
    input.version === repositoryVersion,
    `Manifest version ${input.version} does not match the repository version ${repositoryVersion}`,
  );
  const notes = assertPlainText(input.notes, 'Manifest notes', {
    maxLength: MAX_NOTES_LENGTH,
    allowNewline: true,
  });
  const pubDate = assertPublicationDate(input.pub_date);

  invariant(isPlainObject(input.platforms), 'Manifest platforms must be an object');
  const platformKeys = Object.keys(input.platforms).sort();
  invariant(platformKeys.length > 0, 'Manifest platforms must describe at least one platform');
  const platforms = {};
  for (const platformKey of platformKeys) {
    invariant(
      Object.prototype.hasOwnProperty.call(UPDATER_PLATFORMS, platformKey),
      `Manifest platform ${JSON.stringify(platformKey)} is not a released updater platform`,
    );
    const entry = input.platforms[platformKey];
    assertExactKeys(entry, PLATFORM_ENTRY_KEYS, `Manifest platform ${platformKey}`);
    const signature = assertCanonicalBase64(entry.signature, `Manifest platform ${platformKey} signature`);
    assertHttpsUrl(entry.url, `Manifest platform ${platformKey} url`);
    platforms[platformKey] = Object.freeze({ signature, url: entry.url });
  }

  return Object.freeze({
    version: input.version,
    notes,
    pub_date: pubDate,
    platforms: Object.freeze(platforms),
  });
}

/** Serializes a manifest to canonical UTF-8 bytes without a byte-order mark. */
function serializeManifest(manifest) {
  assertExactKeys(manifest, MANIFEST_KEYS, 'Manifest');
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  invariant(bytes.length > 0, 'Manifest serialized to an empty document');
  invariant(
    !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
    'Manifest must not start with a byte-order mark',
  );
  return bytes;
}

function resolveRepositoryVersion(rootDirectory = REPOSITORY_ROOT) {
  return assertAllVersionsMatch(collectRepositoryVersions(rootDirectory).versions);
}

function platformBundleDirectory(bundleRoot, platformKey) {
  const layout = UPDATER_PLATFORMS[platformKey];
  invariant(layout, `Unknown updater platform ${JSON.stringify(platformKey)}`);
  return path.join(bundleRoot, layout.target, 'release', 'bundle', BUNDLE_LAYOUTS[layout.bundle].directory);
}

/**
 * Rewrites absolute locations out of a message so failures never disclose a
 * path outside the requested bundle directory.
 */
function redactLocations(message, { bundleRoot, rootDirectory }) {
  let text = String(message);
  for (const [absolute, label] of [[bundleRoot, '<bundle>'], [rootDirectory, '<repository>']]) {
    if (!absolute) {
      continue;
    }
    for (const variant of new Set([absolute, absolute.replaceAll('\\', '/'), absolute.replaceAll('/', '\\')])) {
      text = text.split(variant).join(label);
    }
  }
  return text;
}

function locateSignedArtifact({ bundleRoot, platformKey, rootDirectory = REPOSITORY_ROOT }) {
  const layout = UPDATER_PLATFORMS[platformKey];
  invariant(layout, `Unknown updater platform ${JSON.stringify(platformKey)}`);
  const directory = platformBundleDirectory(bundleRoot, platformKey);
  invariant(fs.existsSync(directory), `No ${platformKey} bundle directory was produced`);

  const extension = layout.artifactExtension.toLowerCase();
  const candidates = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .filter((entry) => !entry.name.toLowerCase().endsWith('.sig'))
    .map((entry) => entry.name)
    .sort();
  invariant(
    candidates.length === 1,
    `Expected exactly one ${platformKey} installer, found ${candidates.length}`,
  );

  const fileName = candidates[0];
  invariant(
    ARTIFACT_NAME_PATTERN.test(fileName) && path.basename(fileName) === fileName,
    `The ${platformKey} installer name is unsafe for a download URL`,
  );
  const artifact = path.join(directory, fileName);
  const signaturePath = `${artifact}.sig`;
  invariant(
    fs.existsSync(signaturePath) && fs.lstatSync(signaturePath).isFile(),
    `The ${platformKey} installer ${fileName} has no .sig sidecar`,
  );

  try {
    assertSafeArtifact(artifact, 'file', layout.target);
    assertUpdaterSignature(artifact, rootDirectory);
  } catch (error) {
    throw new Error(redactLocations(error.message, { bundleRoot, rootDirectory }));
  }

  const signature = assertCanonicalBase64(
    fs.readFileSync(signaturePath, 'utf8').trim(),
    `The ${platformKey} signature`,
  );
  return { fileName, signature };
}

function collectPlatforms({ bundleRoot, platformKeys, baseUrl, rootDirectory = REPOSITORY_ROOT }) {
  invariant(Array.isArray(platformKeys) && platformKeys.length > 0, 'At least one --platform is required');
  invariant(new Set(platformKeys).size === platformKeys.length, '--platform may not be repeated');
  const base = assertHttpsUrl(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`, 'Download base url');
  invariant(!base.search, 'Download base url must not carry a query string');

  const platforms = {};
  for (const platformKey of [...platformKeys].sort()) {
    const { fileName, signature } = locateSignedArtifact({ bundleRoot, platformKey, rootDirectory });
    platforms[platformKey] = {
      signature,
      url: new URL(encodeURIComponent(fileName), base).toString(),
    };
  }
  return platforms;
}

function parseArguments(arguments_) {
  const parsed = { platformKeys: [] };
  const single = new Map([
    ['--bundle-root', 'bundleRoot'],
    ['--base-url', 'baseUrl'],
    ['--notes', 'notes'],
    ['--version', 'version'],
    ['--pub-date', 'pubDate'],
    ['--output', 'output'],
  ]);

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--help' || argument === '-h') {
      return { help: true, platformKeys: [] };
    }
    if (argument === '--platform') {
      const value = arguments_[index + 1];
      invariant(typeof value === 'string' && value.trim(), '--platform requires a value');
      parsed.platformKeys.push(value.trim());
      index += 1;
      continue;
    }
    const field = single.get(argument);
    invariant(field, `Unknown argument ${JSON.stringify(argument)}`);
    invariant(parsed[field] === undefined, `${argument} may only be given once`);
    const value = arguments_[index + 1];
    invariant(typeof value === 'string' && value.trim(), `${argument} requires a value`);
    parsed[field] = value.trim();
    index += 1;
  }

  invariant(parsed.bundleRoot, '--bundle-root is required');
  invariant(parsed.baseUrl, '--base-url is required');
  invariant(parsed.notes, '--notes is required');
  invariant(parsed.platformKeys.length > 0, 'At least one --platform is required');
  for (const platformKey of parsed.platformKeys) {
    invariant(
      Object.prototype.hasOwnProperty.call(UPDATER_PLATFORMS, platformKey),
      `Unsupported updater platform ${JSON.stringify(platformKey)}`,
    );
  }
  return { help: false, ...parsed };
}

function main(argv = process.argv.slice(2), { rootDirectory = REPOSITORY_ROOT } = {}) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const bundleRoot = path.resolve(options.bundleRoot);
  invariant(fs.existsSync(bundleRoot), 'The requested bundle root does not exist');
  const repositoryVersion = resolveRepositoryVersion(rootDirectory);
  const platforms = collectPlatforms({
    bundleRoot,
    platformKeys: options.platformKeys,
    baseUrl: options.baseUrl,
    rootDirectory,
  });
  const manifest = buildManifest(
    {
      version: options.version ?? repositoryVersion,
      notes: options.notes,
      pub_date: options.pubDate ?? new Date().toISOString(),
      platforms,
    },
    { repositoryVersion },
  );
  const bytes = serializeManifest(manifest);

  if (options.output === undefined) {
    process.stdout.write(bytes);
    return;
  }
  const output = path.resolve(bundleRoot, options.output);
  const relative = path.relative(bundleRoot, output);
  invariant(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'The manifest output must stay inside the requested bundle root',
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, bytes, { flag: 'wx' });
  console.log(
    `Updater manifest ${relative.replaceAll('\\', '/')} built for ${manifest.version}: ${Object.keys(platforms).length} verified platforms.`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Updater manifest generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  UPDATER_PLATFORMS,
  USAGE,
  buildManifest,
  collectPlatforms,
  locateSignedArtifact,
  main,
  parseArguments,
  platformBundleDirectory,
  redactLocations,
  resolveRepositoryVersion,
  serializeManifest,
};
