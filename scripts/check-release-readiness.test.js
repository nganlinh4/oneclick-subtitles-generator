const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ACTION_PINS,
  RELEASE_MATRIX,
  assertLockfiles,
  assertPinnedActions,
  assertPinnedToolchains,
  assertProductionCsp,
  assertEffectiveToolchain,
  assertLoopbackAuditManifest,
  assertManagedEngineDelivery,
  assertNativeToolDelivery,
  assertNoMissingNativeCapabilities,
  assertNoUnmanagedLocalServices,
  assertRepositoryReleasePolicy,
  assertRequiredMediaToolDelivery,
  assertRenderRuntimeDelivery,
  assertUpdaterReleaseConfiguration,
  assertWorkerResources,
  assertWorkflowCommands,
  assertWorkflowMatrix,
  checkRuntimePackageReadiness,
  collectResourceMappings,
  collectPromptDjFontReleasePolicyFailures,
  normalizeDestination,
  parseArguments,
} = require('./check-release-readiness');

function writeFile(root, relativePath, contents = 'fixture') {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
  return absolutePath;
}

function createWorkerFixture({ packageSpeech = true, packageRender = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-release-readiness-'));
  writeFile(root, '.gitattributes', '*.mjs text eol=lf\n*.py text eol=lf\n');
  writeFile(root, 'crates/osg-asr/worker/osg_asr_worker.py', 'asr worker');
  writeFile(root, 'crates/osg-speech/worker/osg_speech_worker.py', 'speech worker');
  writeFile(root, 'video-renderer/worker/osg_render_worker.mjs', 'render worker');
  writeFile(
    root,
    'apps/desktop/src-tauri/src/asr.rs',
    'const WORKER: &[u8] = include_bytes!("../../../../crates/osg-asr/worker/osg_asr_worker.py");',
  );
  writeFile(
    root,
    'apps/desktop/src-tauri/src/speech.rs',
    'const WORKER: &[u8] = include_bytes!("../../../../crates/osg-speech/worker/osg_speech_worker.py");',
  );
  writeFile(
    root,
    'apps/desktop/src-tauri/src/render.rs',
    'const WORKER: &[u8] = include_bytes!("../../../../video-renderer/worker/osg_render_worker.mjs");',
  );
  const resources = {
    '../../../crates/osg-asr/worker/osg_asr_worker.py': 'workers/osg_asr_worker.py',
  };
  if (packageRender) {
    resources['../../../video-renderer/worker/osg_render_worker.mjs'] =
      'workers/osg_render_worker.mjs';
  }
  if (packageSpeech) {
    resources['../../../crates/osg-speech/worker/osg_speech_worker.py'] =
      'workers/osg_speech_worker.py';
  }
  writeFile(
    root,
    'apps/desktop/src-tauri/tauri.conf.json',
    JSON.stringify({ bundle: { resources } }),
  );
  return root;
}

function createNativeToolFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-native-tool-readiness-'));
  const repositoryRoot = path.resolve(__dirname, '..');
  for (const relativePath of [
    'crates/osg-native-tools/delivery/native-tools.delivery.json',
    'crates/osg-native-tools/delivery/native-tools.upstreams.lock.json',
  ]) {
    writeFile(root, relativePath, fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
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

function createDependencyPinFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-dependency-pins-'));
  const rootPackage = {
    packageManager: 'npm@11.17.0',
    dependencies: {
      '@tauri-apps/api': '2.11.1',
      react: '18.3.1',
      'react-dom': '18.3.1',
    },
    devDependencies: {
      '@tauri-apps/cli': '2.11.4',
      '7zip-bin-full': '26.2.1',
    },
  };
  const workspacePackage = {
    dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
  };
  writeFile(root, '.node-version', '24.19.0\n');
  writeFile(root, 'package.json', JSON.stringify(rootPackage));
  writeFile(
    root,
    'apps/desktop/package.json',
    JSON.stringify({
      packageManager: 'npm@11.17.0',
      devDependencies: { '@tauri-apps/cli': '2.11.4' },
    }),
  );
  writeFile(root, 'promptdj-midi/package.json', JSON.stringify(workspacePackage));
  writeFile(root, 'video-renderer/package.json', JSON.stringify(workspacePackage));
  writeFile(
    root,
    'rust-toolchain.toml',
    '[toolchain]\nchannel = "1.97.1"\nprofile = "minimal"\ncomponents = ["clippy", "rustfmt"]\n',
  );
  writeFile(
    root,
    'Cargo.toml',
    '[workspace]\nmembers = ["crates/example"]\n\n[workspace.package]\nrust-version = "1.97"\n',
  );
  return { root, rootPackage, workspacePackage };
}

test('accepts only reviewed full-SHA GitHub Action pins', () => {
  const workflow = Object.entries(ACTION_PINS)
    .map(([action, pin]) => `      - uses: ${action}@${pin}`)
    .join('\n');
  assert.doesNotThrow(() => assertPinnedActions(workflow));
  for (const pin of Object.values(ACTION_PINS)) {
    assert.throws(
      () => assertPinnedActions(workflow.replace(pin, 'v0')),
      /full commit SHA/,
    );
    assert.throws(
      () => assertPinnedActions(workflow.replace(pin, '0'.repeat(40))),
      /reviewed pin/,
    );
  }
});

test('pins the reviewed React pair and release inspection dependency in every manifest', (context) => {
  const { root, rootPackage } = createDependencyPinFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  assert.doesNotThrow(() => assertPinnedToolchains(root));

  rootPackage.dependencies.react = '^18.2.0';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(rootPackage));
  assert.throws(
    () => assertPinnedToolchains(root),
    /package\.json must pin React and React DOM to the reviewed 18\.3\.1 pair/,
  );

  rootPackage.dependencies.react = '18.3.1';
  rootPackage.devDependencies['7zip-bin-full'] = '^26.2.1';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(rootPackage));
  assert.throws(
    () => assertPinnedToolchains(root),
    /must pin 7zip-bin-full to exact version 26\.2\.1/,
  );
});

test('lockfiles bind reviewed registry artifacts and exact React workspace parity', (context) => {
  const { root } = createDependencyPinFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const genericIntegrity = `sha512-${Buffer.alloc(64, 0x5a).toString('base64')}`;
  const tauriCli = {
    version: '2.11.4',
    resolved: 'https://registry.npmjs.org/@tauri-apps/cli/-/cli-2.11.4.tgz',
    integrity: genericIntegrity,
  };
  const rootLock = {
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
        devDependencies: { '7zip-bin-full': '26.2.1' },
      },
      'node_modules/@tauri-apps/cli': tauriCli,
      'node_modules/7zip-bin-full': {
        version: '26.2.1',
        resolved: 'https://registry.npmjs.org/7zip-bin-full/-/7zip-bin-full-26.2.1.tgz',
        integrity: 'sha512-h1DE4G8WEJ3/LI4HTcuOpouP7cy9JGqYfZm5fzLhdzw8jI3wFyA9RFu5MP+ICzelKEYmWweRWApEvVWKmJIdVQ==',
        dev: true,
        license: 'MIT',
      },
      'node_modules/react': {
        version: '18.3.1',
        resolved: 'https://registry.npmjs.org/react/-/react-18.3.1.tgz',
        integrity: genericIntegrity,
      },
      'node_modules/react-dom': {
        version: '18.3.1',
        resolved: 'https://registry.npmjs.org/react-dom/-/react-dom-18.3.1.tgz',
        integrity: genericIntegrity,
      },
      'promptdj-midi': {
        dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
        link: true,
      },
      'video-renderer': {
        dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
        link: true,
      },
    },
  };
  const desktopLock = {
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/@tauri-apps/cli': tauriCli,
    },
  };
  writeFile(root, 'package-lock.json', JSON.stringify(rootLock));
  writeFile(root, 'apps/desktop/package-lock.json', JSON.stringify(desktopLock));
  writeFile(root, 'Cargo.lock', 'version = 4\n');
  assert.doesNotThrow(() => assertLockfiles(root));

  rootLock.packages['node_modules/7zip-bin-full'].integrity = genericIntegrity;
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(rootLock));
  assert.throws(
    () => assertLockfiles(root),
    /must bind 7zip-bin-full to its reviewed registry artifact/,
  );

  rootLock.packages['node_modules/7zip-bin-full'].integrity =
    'sha512-h1DE4G8WEJ3/LI4HTcuOpouP7cy9JGqYfZm5fzLhdzw8jI3wFyA9RFu5MP+ICzelKEYmWweRWApEvVWKmJIdVQ==';
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(rootLock));
  writeFile(
    root,
    'Cargo.lock',
    `version = 4\n\n[[package]]\nname = "git-fixture"\nversion = "1.0.0"\nsource = "git+https://example.test/repository.git#${'a'.repeat(40)}"\n`,
  );
  assert.doesNotThrow(() => assertLockfiles(root));
  writeFile(
    root,
    'Cargo.lock',
    'version = 4\n\n[[package]]\nname = "git-fixture"\nversion = "1.0.0"\nsource = "git+https://example.test/repository.git#main"\n',
  );
  assert.throws(
    () => assertLockfiles(root),
    /git dependency git-fixture must use HTTPS and a full commit revision/,
  );
});

test('requires all four immutable host/target/package matrix entries', () => {
  const entries = RELEASE_MATRIX.map(
    ({ platform, os: runner, target, bundles }) =>
      `          - platform: ${platform}\n            os: ${runner}\n            rust-target: ${target}\n            bundles: ${bundles}`,
  ).join('\n');
  const workflow = `      matrix:\n        include:\n${entries}\n\n    steps:\n`;
  assert.doesNotThrow(() => assertWorkflowMatrix(workflow));
  assert.throws(
    () => assertWorkflowMatrix(workflow.replace('macos-15-intel', 'macos-latest')),
    /mutable \*-latest aliases/,
  );
});

test('workflow is unsigned, read-only, credentialless, and locked', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '..', '.github/workflows/rewrite-ci.yml'),
    'utf8',
  );
  assert.doesNotThrow(() => assertWorkflowCommands(workflow));
  assert.throws(
    () => assertWorkflowCommands(workflow.replace('contents: read', 'contents: write')),
    /permissions must remain contents: read only/,
  );
  assert.throws(
    () => assertWorkflowCommands(workflow.replace('persist-credentials: false', 'persist-credentials: true')),
    /Every checkout step must disable persisted Git credentials/,
  );
  assert.throws(
    () => assertWorkflowCommands(workflow.replace("if: github.event_name == 'workflow_dispatch'", 'if: always()')),
    /Unsigned package validation must be manual-only/,
  );
  const nativeSetupPython = `uses: actions/setup-python@${ACTION_PINS['actions/setup-python']}`;
  const nativeSetupIndex = workflow.lastIndexOf(nativeSetupPython);
  assert.notEqual(nativeSetupIndex, -1);
  const nativeWithoutPython =
    workflow.slice(0, nativeSetupIndex) +
    '# native setup-python intentionally removed' +
    workflow.slice(nativeSetupIndex + nativeSetupPython.length);
  assert.throws(
    () => assertWorkflowCommands(nativeWithoutPython),
    /native-matrix must install Python through the reviewed setup-python action/,
  );
  const nativeSetupNode = `uses: actions/setup-node@${ACTION_PINS['actions/setup-node']}`;
  const nativeNodeIndex = workflow.lastIndexOf(nativeSetupNode);
  assert.notEqual(nativeNodeIndex, -1);
  const nativeWithoutNode =
    workflow.slice(0, nativeNodeIndex) +
    '# native setup-node intentionally removed' +
    workflow.slice(nativeNodeIndex + nativeSetupNode.length);
  assert.throws(
    () => assertWorkflowCommands(nativeWithoutNode),
    /native-matrix must install Node through the reviewed setup-node action/,
  );
  for (const gate of [
    'node --test scripts/frozen-css-compatibility.test.mjs scripts/check-frozen-css-output.test.mjs',
    'npm run build:frontend',
    'node scripts/check-frozen-css-output.mjs',
  ]) {
    assert.throws(
      () => assertWorkflowCommands(workflow.replace(gate, 'gate intentionally removed')),
      /workflow is missing required locked gate/,
    );
  }
});

test('production CSP rejects provider and development network endpoints', () => {
  assert.doesNotThrow(() =>
    assertProductionCsp({
      app: {
        security: {
          csp: {
            'connect-src': "'self' ipc: http://ipc.localhost",
            'img-src': "'self' data: blob: http://127.0.0.1:*",
          },
        },
      },
    }),
  );
  for (const endpoint of [
    'https://generativelanguage.googleapis.com',
    'http://localhost:3030',
    'http://127.0.0.1:*',
    'https:',
  ]) {
    assert.throws(
      () =>
        assertProductionCsp({
          app: {
            security: {
              csp: {
                'connect-src': `\'self\' ipc: ${endpoint}`,
                'img-src': "'self' data: blob: http://127.0.0.1:*",
              },
            },
          },
        }),
      /only self\/Tauri IPC endpoints/,
    );
  }
  for (const imageSource of [
    "'self' data: blob: https:",
    "'self' data: blob: https://i.ytimg.com",
    "'self' data: blob:",
  ]) {
    assert.throws(
      () => assertProductionCsp({
        app: {
          security: {
            csp: {
              'connect-src': "'self' ipc: http://ipc.localhost",
              'img-src': imageSource,
            },
          },
        },
      }),
      /only local assets and tokenized loopback images/,
    );
  }
});

function createUpdaterFixture({
  endpoint = 'https://example.invalid/releases/latest/download/latest.json',
  permission = 'check-for-updates',
  publicKey = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-updater-readiness-'));
  const keyBytes = Buffer.concat([Buffer.from('Ed'), Buffer.from(Array.from({ length: 40 }, (_, index) => index + 1))]);
  const minisignKey = keyBytes.toString('base64');
  const encodedPublicKey = publicKey ?? Buffer.from(
    `untrusted comment: minisign public key test fixture\n${minisignKey}\n`,
    'utf8',
  ).toString('base64');
  writeFile(root, 'apps/desktop/src-tauri/updater-public-key.txt', `${encodedPublicKey}\n`);
  writeFile(
    root,
    'apps/desktop/src-tauri/tauri.conf.json',
    JSON.stringify({
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: { endpoints: [endpoint], pubkey: '' } },
    }),
  );
  writeFile(
    root,
    'apps/desktop/src-tauri/capabilities/main.json',
    JSON.stringify({ permissions: [permission] }),
  );
  return root;
}

test('signed updater release gate requires a real key, HTTPS latest.json, and no guest API', (context) => {
  const validRoot = createUpdaterFixture();
  const placeholderRoot = createUpdaterFixture({ publicKey: 'UNCONFIGURED' });
  const insecureRoot = createUpdaterFixture({ endpoint: 'http://example.invalid/latest.json' });
  const guestRoot = createUpdaterFixture({ permission: 'updater:default' });
  context.after(() => {
    for (const root of [validRoot, placeholderRoot, insecureRoot, guestRoot]) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  assert.doesNotThrow(() => assertUpdaterReleaseConfiguration(validRoot));
  assert.throws(() => assertUpdaterReleaseConfiguration(placeholderRoot), /still a placeholder/);
  assert.throws(() => assertUpdaterReleaseConfiguration(insecureRoot), /must use HTTPS/);
  assert.throws(() => assertUpdaterReleaseConfiguration(guestRoot), /must not grant updater guest permissions/);
});

test('embedded ASR, speech, and render workers map to exact runtime destinations', (context) => {
  const root = createWorkerFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const mappings = collectResourceMappings(root);
  assert.doesNotThrow(() => assertWorkerResources(root, mappings));
});

test('worker resource validation fail-closes when speech is omitted', (context) => {
  const root = createWorkerFixture({ packageSpeech: false });
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const mappings = collectResourceMappings(root);
  assert.throws(() => assertWorkerResources(root, mappings), /speech\.rs embeds osg_speech_worker\.py/);
});

test('worker resource validation fail-closes when the render worker is omitted', (context) => {
  const root = createWorkerFixture({ packageRender: false });
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const mappings = collectResourceMappings(root);
  assert.throws(
    () => assertWorkerResources(root, mappings),
    /render\.rs embeds osg_render_worker\.mjs/,
  );
});

test('worker resource validation fail-closes on platform-dependent checkout bytes', (context) => {
  const root = createWorkerFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  writeFile(root, '.gitattributes', '*.mjs text\n*.py text\n');
  const mappings = collectResourceMappings(root);
  assert.throws(
    () => assertWorkerResources(root, mappings),
    /must include \*\.mjs text eol=lf/,
  );
});

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

test('runtime targets report only their honest release blocker groups', () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  for (const { target } of RELEASE_MATRIX) {
    if (target === 'x86_64-pc-windows-msvc') {
      assert.doesNotThrow(() => checkRuntimePackageReadiness(repositoryRoot, target));
      continue;
    }
    assert.throws(
      () => checkRuntimePackageReadiness(repositoryRoot, target),
      (error) => {
        assert.match(error.message, /Runtime package has 3 blocking violation\(s\)/);
        assert.match(error.message, /FFmpeg\/ffprobe delivery is unavailable/);
        assert.match(error.message, /Remotion delivery catalog/);
        assert.match(error.message, /Managed engine delivery/);
        assert.doesNotMatch(error.message, /updater public key is still a placeholder/i);
        assert.doesNotMatch(error.message, /Repository licensing\/notice policy is unresolved/);
        assert.doesNotMatch(error.message, /bundle pinned|yt-dlp\.exe|deno\.exe/);
        return true;
      },
    );
  }
});

test('Remotion delivery requires exact cross-component payload and license inventory', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-remotion-delivery-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const worker = 'reviewed render worker';
  writeFile(root, 'video-renderer/worker/osg_render_worker.mjs', worker);
  const digest = (contents) => crypto.createHash('sha256').update(contents).digest('hex');
  const file = (role, filePath, executable = false) => ({
    executable,
    path: filePath,
    role,
    sha256: digest(`${role}:${filePath}`),
    sizeBytes: Buffer.byteLength(`${role}:${filePath}`),
  });
  const noticePath = 'licenses/THIRD_PARTY_NOTICES.txt';
  const source = (id) => `https://downloads.example.test/${id}/1.2.3/${id}-1.2.3.zip`;
  const catalog = {
    schemaVersion: 1,
    protocolVersion: 1,
    remotionVersion: '4.0.507',
    worker: {
      sourcePath: 'video-renderer/worker/osg_render_worker.mjs',
      sizeBytes: Buffer.byteLength(worker),
      sha256: digest(worker),
    },
    platforms: {
      'x86_64-pc-windows-msvc': {
        releases: [{
          archiveFormat: 'zip',
          archiveSha256: 'a'.repeat(64),
          archiveSizeBytes: 100,
          components: [
            ['node', '24.19.0'],
            ['chromium', '140.0.7339'],
            ['remotion', '4.0.507'],
            ['remotion-binaries', '4.0.507'],
            ['font-pack', '1.0.0'],
          ].map(([id, version]) => ({
            id,
            version,
            sourceUrl: source(id),
            license: { spdx: 'MIT', noticePath },
          })),
          files: [
            file('node', 'node/node.exe', true),
            file('browser', 'chromium/chrome.exe', true),
            file('rendererPackage', 'renderer/package.json'),
            file('bundleIndex', 'bundle/index.html'),
            file('binariesMarker', 'binaries/.ready'),
            file('fontManifest', 'bundle/fonts/fonts.css'),
            file('notices', noticePath),
            file('payload', 'renderer/index.js'),
          ],
          manifest: {
            path: 'remotion-runtime.json',
            sha256: 'b'.repeat(64),
            sizeBytes: 200,
          },
          remotionVersion: '4.0.507',
          sourceUrl: source('runtime'),
          target: 'x86_64-pc-windows-msvc',
          unpackedSizeBytes: 1_000,
          version: '1.0.0',
        }],
      },
    },
  };
  const catalogPath = 'video-renderer/delivery/remotion-runtime.delivery.json';
  writeFile(root, catalogPath, JSON.stringify(catalog));
  assert.throws(() =>
    assertRenderRuntimeDelivery(root, 'x86_64-pc-windows-msvc'),
    /no packaged render-runtime resource tree\/receipt or managed installer wiring/,
  );

  const release = catalog.platforms['x86_64-pc-windows-msvc'].releases[0];
  const resources = {};
  for (const runtimeFile of release.files) {
    const sourcePath = `runtime-fixture/${runtimeFile.path}`;
    writeFile(root, sourcePath, `${runtimeFile.role}:${runtimeFile.path}`);
    resources[`../../../${sourcePath}`] =
      `render-runtime/x86_64-pc-windows-msvc/${runtimeFile.path}`;
  }
  const manifestContents = `${JSON.stringify({
    schemaVersion: 1,
    target: 'x86_64-pc-windows-msvc',
    remotionVersion: '4.0.507',
    files: release.files.map(({ role, path: filePath, sizeBytes, sha256 }) => ({
      role,
      path: filePath,
      sizeBytes,
      sha256,
    })),
  })}\n`;
  const manifestSource = 'runtime-fixture/remotion-runtime.json';
  writeFile(root, manifestSource, manifestContents);
  release.manifest.sizeBytes = Buffer.byteLength(manifestContents);
  release.manifest.sha256 = digest(manifestContents);
  resources[`../../../${manifestSource}`] =
    'render-runtime/x86_64-pc-windows-msvc/remotion-runtime.json';
  writeFile(
    root,
    'apps/desktop/src-tauri/tauri.conf.json',
    JSON.stringify({ bundle: { resources } }),
  );
  fs.writeFileSync(path.join(root, catalogPath), JSON.stringify(catalog));
  assert.doesNotThrow(() =>
    assertRenderRuntimeDelivery(root, 'x86_64-pc-windows-msvc'),
  );

  writeFile(root, 'runtime-fixture/renderer/index.js', 'tampered renderer payload');
  assert.throws(
    () => assertRenderRuntimeDelivery(root, 'x86_64-pc-windows-msvc'),
    /no packaged render-runtime resource tree\/receipt or managed installer wiring/,
  );
  writeFile(root, 'runtime-fixture/renderer/index.js', 'payload:renderer/index.js');
  catalog.platforms['x86_64-pc-windows-msvc'].releases[0].components =
    catalog.platforms['x86_64-pc-windows-msvc'].releases[0].components
      .filter((component) => component.id !== 'font-pack');
  fs.writeFileSync(path.join(root, catalogPath), JSON.stringify(catalog));
  assert.throws(
    () => assertRenderRuntimeDelivery(root, 'x86_64-pc-windows-msvc'),
    /components must be exactly/,
  );
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

test('production rejects unmanaged loopback endpoints but accepts the explicit browser-only guard', (context) => {
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
    'src/utils/browserCompatibility.js',
    [
      "import { guardBrowserOnlyServiceOrigin } from '../platform/browserOnlyService';",
      "const SERVER = guardBrowserOnlyServiceOrigin('http://localhost:3031');",
      'export const ping = () => fetch(`${SERVER}/health`);',
    ].join('\n'),
  );
  assert.doesNotThrow(() => assertNoUnmanagedLocalServices(root));
  fs.rmSync(path.join(root, 'src/utils/browserCompatibility.js'));
  writeFile(
    root,
    'src/utils/fakeGuard.js',
    [
      'const guardBrowserOnlyServiceOrigin = (value) => value;',
      "export const SERVER = guardBrowserOnlyServiceOrigin('http://localhost:3031');",
    ].join('\n'),
  );
  assert.throws(
    () => assertNoUnmanagedLocalServices(root),
    /Production frontend still contains unmanaged loopback service endpoints/,
  );
  fs.rmSync(path.join(root, 'src/utils/fakeGuard.js'));
  writeFile(
    root,
    'src/utils/spoofedGuard.js',
    [
      "import { guardBrowserOnlyServiceOrigin } from './fake/browserOnlyService';",
      "export const SERVER = guardBrowserOnlyServiceOrigin('http://localhost:3031');",
    ].join('\n'),
  );
  assert.throws(
    () => assertNoUnmanagedLocalServices(root),
    /Production frontend still contains unmanaged loopback service endpoints/,
  );
  fs.rmSync(path.join(root, 'src/utils/spoofedGuard.js'));
  writeFile(
    root,
    'src/utils/forcedBrowserGuard.js',
    [
      "import { guardBrowserOnlyServiceOrigin } from '../platform/browserOnlyService';",
      "export const SERVER = guardBrowserOnlyServiceOrigin('http://localhost:3031', { nativeRuntime: false });",
    ].join('\n'),
  );
  assert.throws(
    () => assertNoUnmanagedLocalServices(root),
    /Production frontend still contains unmanaged loopback service endpoints/,
  );
  fs.rmSync(path.join(root, 'src/utils/forcedBrowserGuard.js'));
  writeFile(
    root,
    'src/platform/mediaCapability.js',
    'const PLAYBACK = /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/asset\\//;',
  );
  assert.doesNotThrow(() => assertNoUnmanagedLocalServices(root));
});

test('the production transport audit is native-only and has no capability blockers', () => {
  const root = path.resolve(__dirname, '..');
  const audit = assertLoopbackAuditManifest(root);
  assert.equal(audit.schemaVersion, 2);
  assert.equal(audit.productionPolicy, 'native-only');
  assert.equal(audit.artifactGate, 'scripts/check-production-transport.js');
  assert.ok(audit.reviewedCompatibilitySources.length <= 3);
  assert.deepEqual(audit.missingCapabilities, []);
  assert.doesNotThrow(() => assertNoMissingNativeCapabilities(root));
});

test('resource destinations cannot escape or alias package paths', () => {
  assert.equal(normalizeDestination('workers/osg_asr_worker.py'), 'workers/osg_asr_worker.py');
  for (const destination of ['../worker.py', '/absolute/worker.py', 'workers//worker.py']) {
    assert.throws(() => normalizeDestination(destination), /Resource destination/);
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

test('effective toolchain versions must equal every repository pin', () => {
  const pins = {
    nodeVersion: '24.19.0',
    packageManager: 'npm@11.17.0',
    pythonVersion: '3.12.10',
    rustVersion: '1.97.1',
  };
  assert.doesNotThrow(() =>
    assertEffectiveToolchain(pins, {
      nodeVersion: '24.19.0',
      npmVersion: '11.17.0',
      pythonVersion: '3.12.10',
      rustVersion: '1.97.1',
    }),
  );
  assert.throws(
    () =>
      assertEffectiveToolchain(pins, {
        nodeVersion: '24.19.0',
        npmVersion: '11.16.0',
        pythonVersion: '3.12.10',
        rustVersion: '1.97.1',
      }),
    /Effective npm is 11\.16\.0/,
  );
  assert.throws(
    () =>
      assertEffectiveToolchain(pins, {
        nodeVersion: '24.19.0',
        npmVersion: '11.17.0',
        pythonVersion: '3.12.9',
        rustVersion: '1.97.1',
      }),
    /Effective Python is 3\.12\.9/,
  );
});
