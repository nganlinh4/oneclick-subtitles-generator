'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readMutableSource, weaken } = require('../mutation-testing');
const {
  assertProductionCsp,
  assertTauriProductionBuildContract,
  assertWorkerResources,
  collectResourceMappings,
  normalizeDestination,
} = require('./tauri-config');
const { writeFile } = require('./test-support');

function createTauriProductionBuildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-tauri-production-build-'));
  writeFile(root, 'package.json', JSON.stringify({
    scripts: {
      build: 'npm run tauri:build',
      'tauri:build': 'node scripts/run-managed-command.js --lane package -- npm --prefix apps/desktop run tauri:build --',
    },
  }));
  writeFile(root, 'apps/desktop/package.json', JSON.stringify({
    scripts: {
      'tauri:build': 'node ../../scripts/run-tauri-cli.js build --features production',
    },
  }));
  writeFile(
    root,
    'apps/desktop/src-tauri/Cargo.toml',
    '[features]\ndefault = []\nproduction = ["tauri/custom-protocol"]\n'
      + '[dependencies]\nrfd = { version = "=0.16.0", default-features = false }\n',
  );
  writeFile(
    root,
    'apps/desktop/src-tauri/src/main.rs',
    '#[cfg(all(not(debug_assertions), not(feature = "production"), not(feature = "unsigned-local-build"), not(feature = "e2e-automation")))]\n'
      + 'compile_error!("release executables must be built with `npm run tauri:build`; '
      + 'plain `cargo build --release` retains the development URL");\n',
  );
  return root;
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

test('Tauri production build contract embeds the frontend instead of retaining the dev URL', (context) => {
  const root = createTauriProductionBuildFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));

  assert.doesNotThrow(() => assertTauriProductionBuildContract(root));
});

test('Tauri production build contract rejects dev-server releases', (context) => {
  const fixtures = Array.from({ length: 5 }, createTauriProductionBuildFixture);
  context.after(() => {
    for (const root of fixtures) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  const [
    rootScript,
    desktopScript,
    cargoFeature,
    rfdPin,
    mainGuard,
  ] = fixtures;
  const rootPackage = JSON.parse(fs.readFileSync(path.join(rootScript, 'package.json'), 'utf8'));
  rootPackage.scripts['tauri:build'] = 'npm --prefix apps/desktop run tauri -- build';
  writeFile(rootScript, 'package.json', JSON.stringify(rootPackage));
  assert.throws(
    () => assertTauriProductionBuildContract(rootScript),
    /Root tauri:build must use the managed package lane/,
  );

  const desktopPackage = JSON.parse(
    fs.readFileSync(path.join(desktopScript, 'apps/desktop/package.json'), 'utf8'),
  );
  desktopPackage.scripts['tauri:build'] = 'tauri build';
  writeFile(desktopScript, 'apps/desktop/package.json', JSON.stringify(desktopPackage));
  assert.throws(
    () => assertTauriProductionBuildContract(desktopScript),
    /Desktop tauri:build must reject unmanaged local builds and enable production protocol/,
  );

  writeFile(
    cargoFeature,
    'apps/desktop/src-tauri/Cargo.toml',
    '[features]\ndefault = []\nproduction = []\n',
  );
  assert.throws(
    () => assertTauriProductionBuildContract(cargoFeature),
    /must enable only tauri\/custom-protocol/,
  );

  const unpinnedCargo = weaken(
    readMutableSource(rfdPin, 'apps/desktop/src-tauri/Cargo.toml'),
    'version = "=0.16.0"',
    'version = "0.16.0"',
    { expected: 1 },
  );
  writeFile(rfdPin, 'apps/desktop/src-tauri/Cargo.toml', unpinnedCargo);
  assert.throws(
    () => assertTauriProductionBuildContract(rfdPin),
    /must pin its direct rfd dependency/,
  );

  writeFile(mainGuard, 'apps/desktop/src-tauri/src/main.rs', 'fn main() {}\n');
  assert.throws(
    () => assertTauriProductionBuildContract(mainGuard),
    /must reject release builds/,
  );
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

test('resource destinations cannot escape or alias package paths', () => {
  assert.equal(normalizeDestination('workers/osg_asr_worker.py'), 'workers/osg_asr_worker.py');
  for (const destination of ['../worker.py', '/absolute/worker.py', 'workers//worker.py']) {
    assert.throws(() => normalizeDestination(destination), /Resource destination/);
  }
});
