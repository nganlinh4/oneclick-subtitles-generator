'use strict';

// ASR and speech/TTS packages: every engine needs a reviewed content-addressed release for the
// target, with exact sizes, hashes, inventories, notices, and wired install commands.

const fs = require('node:fs');
const path = require('node:path');

const { ENGINE_PLATFORM_BY_TARGET, invariant, readJson } = require('./shared');
const {
  assertCommandWiring,
  assertImmutableSourceUrl,
  assertSafeManifestPath,
} = require('./delivery-common');

const ASR_DELIVERY_PATH = 'crates/osg-engine-packages/delivery/engine-packages.delivery.json';
const SPEECH_DELIVERY_PATH = 'crates/osg-speech/delivery/speech-packages.delivery.json';

const ASR_ENGINE_IDS = Object.freeze([
  'parakeet',
  'faster-whisper-turbo',
  'faster-whisper-large-v3',
  'qwen3-asr-1.7b',
  'qwen3-asr-0.6b',
]);

const SPEECH_BACKEND_IDS = Object.freeze([
  'f5-tts',
  'chatterbox',
  'edge-tts',
  'gtts',
  'gemini-tts',
]);

function assertDeliveryRelease(release, label, { requireModel, requireSourceUrl }) {
  invariant(release && typeof release === 'object' && !Array.isArray(release), `${label} must be an object`);
  invariant(
    typeof release.version === 'string' &&
      /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/.test(release.version) &&
      !/latest/i.test(release.version),
    `${label} must pin an exact version`,
  );
  const asset = assertSafeManifestPath(release.asset, `${label}.asset`);
  invariant(
    release.manifest === undefined ? asset.endsWith('.zip') : asset.endsWith('.manifest.json'),
    `${label}.asset must be a content-addressed archive or remote manifest`,
  );
  invariant(/^[0-9a-f]{64}$/i.test(release.sha256), `${label}.sha256 must be a full SHA-256 digest`);
  invariant(
    asset.includes(release.sha256.slice(0, 16).toLowerCase()),
    `${label}.asset must include the first 16 archive-hash characters`,
  );
  invariant(
    Number.isSafeInteger(release.sizeBytes) && release.sizeBytes > 0,
    `${label}.sizeBytes must be a positive integer`,
  );
  invariant(
    Number.isSafeInteger(release.unpackedSizeBytes) && release.unpackedSizeBytes > 0,
    `${label}.unpackedSizeBytes must be a positive integer`,
  );
  assertSafeManifestPath(release.pythonRelativePath, `${label}.pythonRelativePath`);
  if (requireModel) {
    assertSafeManifestPath(release.modelRelativePath, `${label}.modelRelativePath`);
  }
  if (requireSourceUrl) {
    assertImmutableSourceUrl(release.sourceUrl, label);
  }
  if (release.manifest !== undefined) {
    const manifest = release.manifest;
    invariant(manifest && typeof manifest === 'object' && !Array.isArray(manifest),
      `${label}.manifest must be an object`);
    const manifestAsset = assertSafeManifestPath(manifest.asset, `${label}.manifest.asset`);
    invariant(!manifestAsset.includes('/') && manifestAsset.endsWith('.manifest.json'),
      `${label}.manifest.asset must be a content-addressed manifest file`);
    invariant(/^[0-9a-f]{64}$/.test(manifest.sha256),
      `${label}.manifest.sha256 must be a full lowercase SHA-256 digest`);
    invariant(manifestAsset.includes(manifest.sha256.slice(0, 16)),
      `${label}.manifest.asset must include its hash prefix`);
    invariant(Number.isSafeInteger(manifest.sizeBytes) && manifest.sizeBytes > 0,
      `${label}.manifest.sizeBytes must be positive`);
    invariant(Array.isArray(manifest.urls) && manifest.urls.length > 0 && manifest.urls.length <= 3,
      `${label}.manifest.urls must contain one to three sources`);
    invariant(Array.isArray(release.files) && release.files.length === 0,
      `${label}.files must stay empty when inventory is remotely hash-bound`);
    invariant(Array.isArray(release.sources) && release.sources.length > 0,
      `${label}.sources must inventory every downloadable payload`);
    let downloadBytes = manifest.sizeBytes;
    for (const [index, source] of release.sources.entries()) {
      const sourceLabel = `${label}.sources[${index}]`;
      invariant(source && typeof source === 'object' && !Array.isArray(source),
        `${sourceLabel} must be an object`);
      invariant(['zip', 'raw'].includes(source.kind), `${sourceLabel}.kind is unsupported`);
      const sourceAsset = assertSafeManifestPath(source.asset, `${sourceLabel}.asset`);
      invariant(!sourceAsset.includes('/'), `${sourceLabel}.asset must be one file name`);
      invariant(/^[0-9a-f]{64}$/.test(source.sha256),
        `${sourceLabel}.sha256 must be a full lowercase SHA-256 digest`);
      invariant(Number.isSafeInteger(source.sizeBytes) && source.sizeBytes > 0,
        `${sourceLabel}.sizeBytes must be positive`);
      invariant(Array.isArray(source.urls) && source.urls.length > 0 && source.urls.length <= 3,
        `${sourceLabel}.urls must contain one to three sources`);
      for (const rawUrl of source.urls) {
        assertImmutableSourceUrl(rawUrl, sourceLabel);
        const url = new URL(rawUrl);
        invariant(decodeURIComponent(url.pathname.split('/').at(-1)) === sourceAsset,
          `${sourceLabel}.asset must match its source URL`);
        const pool = url.hostname === 'github.com'
          && url.pathname.startsWith('/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/');
        const huggingFace = url.hostname === 'huggingface.co'
          && /\/resolve\/[0-9a-f]{40}\//.test(url.pathname);
        invariant(pool || huggingFace,
          `${sourceLabel} must use the reviewed bundle pool or an immutable Hugging Face revision`);
      }
      downloadBytes += source.sizeBytes;
      invariant(Number.isSafeInteger(downloadBytes), `${label} download size overflows`);
    }
    for (const rawUrl of manifest.urls) {
      assertImmutableSourceUrl(rawUrl, `${label}.manifest`);
      const url = new URL(rawUrl);
      invariant(url.hostname === 'github.com'
        && url.pathname === `/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/${manifestAsset}`,
      `${label}.manifest must use the reviewed bundle pool`);
    }
    invariant(release.sizeBytes === downloadBytes,
      `${label}.sizeBytes must equal manifest plus source bytes`);
    return;
  }
  invariant(Array.isArray(release.files) && release.files.length > 0, `${label}.files must not be empty`);
  const roles = new Set();
  const filePaths = new Set();
  for (const [index, file] of release.files.entries()) {
    const fileLabel = `${label}.files[${index}]`;
    invariant(file && typeof file === 'object' && !Array.isArray(file), `${fileLabel} must be an object`);
    const filePath = assertSafeManifestPath(file.path, `${fileLabel}.path`);
    invariant(!filePaths.has(filePath), `${label} contains duplicate file path ${filePath}`);
    filePaths.add(filePath);
    invariant(Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0, `${fileLabel}.sizeBytes must be positive`);
    invariant(/^[0-9a-f]{64}$/i.test(file.sha256), `${fileLabel}.sha256 must be a full SHA-256 digest`);
    invariant(['runtime', 'model', 'aligner', 'license'].includes(file.role), `${fileLabel}.role is unsupported`);
    roles.add(file.role);
  }
  invariant(roles.has('runtime'), `${label} must inventory its Python runtime`);
  invariant(roles.has('license'), `${label} must inventory license notices`);
  if (requireModel) {
    invariant(roles.has('model'), `${label} must inventory its model payload`);
  }
}

function assertDeliveryEntries(platform, collectionName, expectedIds, label, optionsForId) {
  const entries = platform && platform[collectionName];
  invariant(Array.isArray(entries), `${label} must contain ${collectionName}`);
  const ids = entries.map((entry) => entry && entry.id);
  invariant(new Set(ids).size === ids.length, `${label} ${collectionName} ids must be unique`);
  invariant(
    ids.length === expectedIds.length && ids.every((id) => expectedIds.includes(id)),
    `${label} ${collectionName} must be exactly: ${expectedIds.join(', ')}`,
  );
  const unavailable = [];
  for (const entry of entries) {
    if (!Array.isArray(entry.releases) || entry.releases.length === 0) {
      unavailable.push(entry.id);
      continue;
    }
    for (const [index, release] of entry.releases.entries()) {
      assertDeliveryRelease(
        release,
        `${label} ${entry.id}.releases[${index}]`,
        optionsForId(entry.id),
      );
    }
  }
  invariant(
    unavailable.length === 0,
    `${label} has no reviewed release for: ${unavailable.join(', ')}`,
  );
}

function assertManagedEngineDelivery(rootDirectory, target) {
  const platformKey = ENGINE_PLATFORM_BY_TARGET[target];
  invariant(platformKey, `Unsupported managed-engine target ${JSON.stringify(target)}`);
  const failures = [];

  try {
    const asrCatalog = readJson(rootDirectory, ASR_DELIVERY_PATH);
    invariant([1, 2].includes(asrCatalog.schemaVersion), 'ASR delivery catalog must use schemaVersion 1 or 2');
    assertDeliveryEntries(
      asrCatalog.platforms && asrCatalog.platforms[platformKey],
      'engines',
      ASR_ENGINE_IDS,
      `ASR delivery catalog ${platformKey}`,
      () => ({ requireModel: true, requireSourceUrl: false }),
    );
    for (const command of [
      'engine_packages_status',
      'engine_package_install',
      'engine_package_remove',
    ]) {
      assertCommandWiring(rootDirectory, command);
    }
  } catch (error) {
    failures.push(error.message);
  }

  try {
    invariant(
      fs.existsSync(path.join(rootDirectory, SPEECH_DELIVERY_PATH)),
      `Speech delivery/install catalog is missing: ${SPEECH_DELIVERY_PATH}`,
    );
    const speechCatalog = readJson(rootDirectory, SPEECH_DELIVERY_PATH);
    invariant([1, 2].includes(speechCatalog.schemaVersion), 'Speech delivery catalog must use schemaVersion 1 or 2');
    assertDeliveryEntries(
      speechCatalog.platforms && speechCatalog.platforms[platformKey],
      'backends',
      SPEECH_BACKEND_IDS,
      `Speech delivery catalog ${platformKey}`,
      (backend) => ({
        requireModel: backend === 'f5-tts' || backend === 'chatterbox',
        requireSourceUrl: true,
      }),
    );
    const commands = speechCatalog.commands;
    invariant(commands && typeof commands === 'object', 'Speech delivery catalog must declare install coordination commands');
    for (const key of ['status', 'install', 'remove']) {
      invariant(typeof commands[key] === 'string', `Speech delivery catalog commands.${key} is missing`);
      assertCommandWiring(rootDirectory, commands[key]);
    }
  } catch (error) {
    failures.push(error.message);
  }

  invariant(
    failures.length === 0,
    `Managed engine delivery has ${failures.length} blocking violation(s): ${failures.join('; ')}`,
  );
}

module.exports = { assertManagedEngineDelivery };
