'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { assertManagedEngineDelivery } = require('./engine-delivery');
const {
  assertRepositoryReleasePolicy,
  collectPromptDjFontReleasePolicyFailures,
} = require('./licensing');
const { assertNativeToolDelivery, assertRequiredMediaToolDelivery } = require('./native-tools');
const { REPOSITORY_ROOT, writeFile } = require('./test-support');

function createNativeToolFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-native-tool-readiness-'));
  for (const relativePath of [
    'crates/osg-native-tools/delivery/native-tools.delivery.json',
    'crates/osg-native-tools/delivery/native-tools.upstreams.lock.json',
  ]) {
    writeFile(root, relativePath, fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8'));
  }
  const commands = [
    'native_tools_catalog',
    'native_tools_status',
    'native_tool_install',
    'native_tool_cancel',
  ].join('\n');
  for (const relativePath of [
    'apps/desktop/src-tauri/build.rs',
    'apps/desktop/src-tauri/src/lib.rs',
    'apps/desktop/src-tauri/permissions/app.toml',
  ]) {
    writeFile(root, relativePath, commands);
  }
  return root;
}

test('managed native-tool delivery validates every target without bundled executables', (context) => {
  const root = createNativeToolFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  assert.doesNotThrow(() => assertNativeToolDelivery(root, []));
  assert.throws(
    () => assertNativeToolDelivery(root, [{ destination: 'bin/yt-dlp.exe' }]),
    /must be installed from the reviewed catalog, not bundled/,
  );
});

test('managed native-tool delivery rejects upstream-audit and immutable-source drift', (context) => {
  const root = createNativeToolFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const deliveryPath = path.join(
    root,
    'crates/osg-native-tools/delivery/native-tools.delivery.json',
  );
  const delivery = JSON.parse(fs.readFileSync(deliveryPath, 'utf8'));
  const ytDlp = delivery.tools.find(({ id }) => id === 'yt-dlp');
  ytDlp.notices[0].sha256 = '0'.repeat(64);
  fs.writeFileSync(deliveryPath, JSON.stringify(delivery));
  assert.throws(
    () => assertNativeToolDelivery(root, []),
    /yt-dlp notice hashes differ from the upstream audit lock/,
  );

  ytDlp.notices[0].sha256 =
    '7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c';
  ytDlp.platforms['windows-x86_64'].releases[0].artifact.sourceUrl =
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  fs.writeFileSync(deliveryPath, JSON.stringify(delivery));
  assert.throws(
    () => assertNativeToolDelivery(root, []),
    /may not use a latest alias/,
  );

  ytDlp.platforms['windows-x86_64'].releases[0].artifact.sourceUrl =
    'https://github.com/yt-dlp/yt-dlp/releases/download/2025.01.01/yt-dlp.exe';
  fs.writeFileSync(deliveryPath, JSON.stringify(delivery));
  assert.throws(
    () => assertNativeToolDelivery(root, []),
    /exact reviewed release tag 2026\.07\.04/,
  );
});

test('media tools are downloadable on Windows and blocked honestly elsewhere', (context) => {
  const root = createNativeToolFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  assert.doesNotThrow(
    () => assertRequiredMediaToolDelivery(root, 'x86_64-pc-windows-msvc'),
  );
  assert.throws(
    () => assertRequiredMediaToolDelivery(root, 'aarch64-apple-darwin'),
    /FFmpeg\/ffprobe delivery is unavailable/,
  );
});

test('repository release policy requires owner-selected license and application notices', (context) => {
  const root = createNativeToolFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  assert.throws(
    () => assertRepositoryReleasePolicy(root),
    /root LICENSE[\s\S]*THIRD_PARTY_NOTICES\.md/i,
  );
});

test('PromptDJ font policy requires per-asset notices for any bundled font', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-font-release-policy-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const openFont = 'promptdj-midi/assets/fonts/Reviewed Open Font.woff2';
  writeFile(root, openFont, 'open font fixture');

  let failures = collectPromptDjFontReleasePolicyFailures(root);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /font assets are absent from THIRD_PARTY_NOTICES\.md/);
  assert.match(failures[0], /Reviewed Open Font\.woff2/);

  writeFile(root, 'THIRD_PARTY_NOTICES.md', `${openFont}\n`);
  failures = collectPromptDjFontReleasePolicyFailures(root);
  assert.deepEqual(failures, []);
});

test('managed ASR and speech delivery requires releases plus real install command wiring', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-engine-delivery-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const sha256 = 'b'.repeat(64);
  const delivery = (id, { model = true, remote = false } = {}) => {
    const files = [
      {
        executable: true,
        path: 'runtime/python.exe',
        role: 'runtime',
        sha256,
        sizeBytes: 10,
      },
      {
        executable: false,
        path: 'licenses/LICENSE.txt',
        role: 'license',
        sha256,
        sizeBytes: 10,
      },
    ];
    if (model) {
      files.push({
        executable: false,
        path: 'model/model.bin',
        role: 'model',
        sha256,
        sizeBytes: 10,
      });
    }
    return {
      asset: `${id}-windows-x86_64-1.2.3-${sha256.slice(0, 16)}.zip`,
      files,
      modelRelativePath: model ? 'model' : undefined,
      pythonRelativePath: 'runtime/python.exe',
      sha256,
      sizeBytes: 100,
      sourceUrl: remote
        ? `https://downloads.example.test/${id}/1.2.3/${id}-${sha256.slice(0, 16)}.zip`
        : undefined,
      unpackedSizeBytes: 200,
      version: '1.2.3',
    };
  };
  const asrIds = [
    'parakeet',
    'faster-whisper-turbo',
    'faster-whisper-large-v3',
    'qwen3-asr-1.7b',
    'qwen3-asr-0.6b',
  ];
  const speechIds = ['f5-tts', 'chatterbox', 'edge-tts', 'gtts', 'gemini-tts'];
  writeFile(
    root,
    'crates/osg-engine-packages/delivery/engine-packages.delivery.json',
    JSON.stringify({
      platforms: {
        'windows-x86_64': {
          engines: asrIds.map((id) => ({ id, releases: [delivery(id)] })),
        },
      },
      schemaVersion: 1,
    }),
  );
  writeFile(
    root,
    'crates/osg-speech/delivery/speech-packages.delivery.json',
    JSON.stringify({
      commands: {
        install: 'speech_package_install',
        remove: 'speech_package_remove',
        status: 'speech_packages_status',
      },
      platforms: {
        'windows-x86_64': {
          backends: speechIds.map((id) => ({
            id,
            releases: [
              delivery(id, {
                model: id === 'f5-tts' || id === 'chatterbox',
                remote: true,
              }),
            ],
          })),
        },
      },
      schemaVersion: 1,
    }),
  );
  const commands = [
    'engine_packages_status',
    'engine_package_install',
    'engine_package_remove',
    'speech_packages_status',
    'speech_package_install',
    'speech_package_remove',
  ].join('\n');
  for (const relativePath of [
    'apps/desktop/src-tauri/build.rs',
    'apps/desktop/src-tauri/src/lib.rs',
    'apps/desktop/src-tauri/permissions/app.toml',
  ]) {
    writeFile(root, relativePath, commands);
  }
  assert.doesNotThrow(() =>
    assertManagedEngineDelivery(root, 'x86_64-pc-windows-msvc'),
  );

  const catalogPath = path.join(
    root,
    'crates/osg-engine-packages/delivery/engine-packages.delivery.json',
  );
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  catalog.platforms['windows-x86_64'].engines[0].releases = [];
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  assert.throws(
    () => assertManagedEngineDelivery(root, 'x86_64-pc-windows-msvc'),
    /ASR delivery catalog windows-x86_64 has no reviewed release for: parakeet/,
  );
});
