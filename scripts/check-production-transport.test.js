'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { build } = require('esbuild');

const {
  assertProductionTransportBoundary,
  assertReachableWebViewTransportBoundary,
  inspectProductionTransport,
  inspectReachableWebViewTransports,
  parseArguments,
} = require('./check-production-transport');

function withSourceGraph(files, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-production-source-'));
  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const destination = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, source);
    }
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withBuild(files, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-production-transport-'));
  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const destination = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, source);
    }
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('accepts Tauri IPC and opaque randomized media capabilities', () => {
  withBuild({
    'assets/app.js': [
      'fetch("http://ipc.localhost/app_health")',
      'const playback = "http://127.0.0.1:" + port + "/asset/" + id;',
      'const help = "https://console.cloud.google.com/apis/api/youtube.googleapis.com";',
      'const geniusHelp = "https://genius.com/api-clients";',
    ].join(';'),
    'promptdj/assets/app.mjs': 'window.parent.postMessage({ event: "ready" }, origin);',
  }, (root) => {
    assert.deepEqual(assertProductionTransportBoundary(root), {
      fileCount: 2,
      violations: [],
    });
  });
});

test('rejects a retired browser OAuth callback even when its body is inert', () => {
  withBuild({
    'assets/app.js': 'console.log("native desktop shell")',
    'oauth2callback.html': '<main>Authentication complete</main>',
  }, (root) => {
    const report = inspectProductionTransport(root);
    assert.deepEqual(
      report.violations.map(({ file, id }) => ({ file, id })),
      [{ file: 'oauth2callback.html', id: 'browser-oauth-callback-artifact' }],
    );
    assert.throws(
      () => assertProductionTransportBoundary(root),
      /retired browser OAuth callback artifact/,
    );
  });
});

test('rejects browser OAuth endpoints and credential or token persistence', () => {
  withBuild({
    'assets/app.js': [
      'window.localStorage.setItem("youtube_client_secret", clientSecret)',
      'sessionStorage?.setItem(`youtube_oauth_token`, JSON.stringify(tokens))',
      'fetch("https://oauth2.googleapis.com/token", { method: "POST" })',
      'window.location.assign("https://accounts.google.com/o/oauth2/v2/auth?client_id=x")',
    ].join(';'),
  }, (root) => {
    const ids = inspectProductionTransport(root).violations.map(({ id }) => id);
    assert.deepEqual(ids, [
      'browser-oauth-provider',
      'browser-oauth-secret-storage',
    ]);
    assert.throws(
      () => assertProductionTransportBoundary(root),
      /browser OAuth (?:provider endpoint|credential or token persistence)/,
    );
  });
});

test('rejects direct Gemini REST and WebSocket provider transports', () => {
  withBuild({
    'assets/rest.js': 'fetch("https://generativelanguage.googleapis.com/v1beta/models")',
    'assets/live.js': 'new WebSocket("wss://aiplatform.googleapis.com/ws/google.cloud.aiplatform")',
  }, (root) => {
    const report = inspectProductionTransport(root);
    assert.deepEqual(
      report.violations.map(({ id }) => id),
      ['direct-gemini-provider', 'direct-gemini-provider'],
    );
    assert.throws(
      () => assertProductionTransportBoundary(root),
      /Production web artifacts cross the native transport boundary/,
    );
  });
});

test('rejects every retired fixed service origin and legacy API routes', () => {
  withBuild({
    'assets/app.js': [
      'fetch("http://localhost:3031/api/cache-info")',
      'new WebSocket("ws://127.0.0.1:3032/progress")',
      'fetch("http://127.0.0.1:3033/render")',
      'fetch("/api/startup-mode")',
    ].join(';'),
  }, (root) => {
    const ids = new Set(inspectProductionTransport(root).violations.map(({ id }) => id));
    assert.deepEqual(ids, new Set([
      'legacy-localhost-service',
      'legacy-loopback-websocket',
      'legacy-fixed-loopback-port',
      'legacy-api-route',
    ]));
  });
});

test('rejects direct WebView byte transports for host-issued playback capabilities', () => {
  withBuild({
    'assets/fetch.js': 'fetch(playable.audioUrl, { cache: "no-store" })',
    'assets/xhr.js': 'const xhr = new XMLHttpRequest(); xhr.open("GET", playbackUrl);',
  }, (root) => {
    assert.deepEqual(
      inspectProductionTransport(root).violations.map(({ id }) => id),
      ['webview-capability-byte-fetch', 'webview-capability-xhr'],
    );
    assert.throws(
      () => assertProductionTransportBoundary(root),
      /WebView (?:byte fetch|XHR) of a host-issued media capability/,
    );
  });
});

test('reachable source graph requires every browser request to use the guarded transport', () => {
  withSourceGraph({
    'src/index.js': "import './capability-consumer.js';",
    'src/capability-consumer.js': 'export const read = (playbackUrl) => fetch(playbackUrl);',
    'src/unreachable.js': 'fetch("https://example.invalid")',
  }, (root) => {
    assert.deepEqual(inspectReachableWebViewTransports(root), {
      moduleCount: 2,
      violations: [{
        file: 'src/capability-consumer.js',
        id: 'raw-fetch',
        count: 1,
      }],
    });
    assert.throws(
      () => assertReachableWebViewTransportBoundary(root),
      /bypasses the guarded browser transport/,
    );
  });
});

test('current production graph has no raw fetch or XHR bypass', () => {
  const report = assertReachableWebViewTransportBoundary();
  assert.equal(report.violations.length, 0);
  assert.ok(report.moduleCount > 400);
});

test('emitted desktop Gemini image graph contains only the opaque native reference transfer', async () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  const imageService = path.join(
    repositoryRoot,
    'src/services/gemini/imageGenerationService.js',
  );
  const result = await build({
    stdin: {
      contents: "export { generateBackgroundImage } from './src/services/gemini/imageGenerationService.js';",
      resolveDir: repositoryRoot,
      sourcefile: 'desktop-image-generation-entry.js',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    treeShaking: true,
    write: false,
    plugins: [{
      name: 'fold-desktop-image-runtime',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^\./ }, (args) => {
          if (path.resolve(args.importer) === imageService) {
            return { path: args.path, external: true };
          }
          return null;
        });
        esbuild.onLoad({ filter: /imageGenerationService\.js$/ }, (args) => {
          if (path.resolve(args.path) !== imageService) return null;
          const source = fs.readFileSync(args.path, 'utf8');
          return {
            contents: source.replace(/\bisDesktopRuntime\s*\(\s*\)/g, 'true'),
            loader: 'js',
          };
        });
      },
    }],
  });
  const emitted = result.outputFiles.map((file) => file.text).join('\n');

  for (const [label, pattern] of [
    ['browser album-art preparation', /prepareAlbumArt/i],
    ['inline image URL', /data:image/i],
    ['inline encoding marker', /base64/i],
    ['canvas encoding', /toDataURL/i],
    ['base64 decoder', /\batob\b/i],
    ['WebView binary object', /\bBlob\b/],
    ['browser provider image payload', /inlineData|responseModalities/i],
  ]) {
    assert.doesNotMatch(emitted, pattern, `desktop image graph retained ${label}`);
  }

  const transfer = await build({
    stdin: {
      contents: "export { importReferenceImage } from './src/platform/imageService.js';",
      resolveDir: repositoryRoot,
      sourcefile: 'desktop-reference-transfer-entry.js',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    treeShaking: true,
    write: false,
  });
  const emittedTransfer = transfer.outputFiles.map((file) => file.text).join('\n');
  assert.match(emittedTransfer, /image_blob_import_playback/);
  assert.doesNotMatch(emittedTransfer, /["'`]image_blob_import["'`]/);
  assert.doesNotMatch(emittedTransfer, /data:image|base64|toDataURL|\batob\b|\bBlob\b/i);

  const featureModules = new Set([
    path.join(repositoryRoot, 'src/components/background/PromptAndAlbumArtSection.js'),
    path.join(repositoryRoot, 'src/components/background/ImageGenerationSection.js'),
  ]);
  const feature = await build({
    stdin: {
      contents: [
        "export { default as PromptAndAlbumArtSection } from './src/components/background/PromptAndAlbumArtSection.js';",
        "export { default as ImageGenerationSection } from './src/components/background/ImageGenerationSection.js';",
      ].join('\n'),
      resolveDir: repositoryRoot,
      sourcefile: 'desktop-image-feature-entry.js',
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    treeShaking: true,
    write: false,
    plugins: [{
      name: 'fold-desktop-image-feature-runtime',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^\./ }, (args) => {
          const resolved = path.resolve(path.dirname(args.importer), args.path);
          if (featureModules.has(resolved) || featureModules.has(`${resolved}.js`)) return null;
          return { path: args.path, external: true };
        });
        esbuild.onLoad({ filter: /(?:PromptAndAlbumArtSection|ImageGenerationSection)\.js$/ }, (args) => {
          if (!featureModules.has(path.resolve(args.path))) return null;
          const source = fs.readFileSync(args.path, 'utf8');
          return {
            contents: source.replace(/\bisDesktopRuntime\s*\(\s*\)/g, 'true'),
            loader: 'jsx',
          };
        });
      },
    }],
  });
  const emittedFeature = feature.outputFiles.map((file) => file.text).join('\n');
  assert.doesNotMatch(
    emittedFeature,
    /generatedFileExportService|generated_file_export|data:image|base64|Uint8Array|\bBlob\b|FileReader|readAsDataURL/i,
  );
  assert.match(emittedFeature, /exportReferenceImagePlayback|exportNativeGeneratedImage/);
});

test('rejects provider images from JavaScript, HTML, and CSS artifacts', () => {
  withBuild({
    'assets/app.js': 'const cover = "https://images.genius.com/cover.jpg";',
    'index.html': '<img src="https://i.ytimg.com/vi/AbCdEfGhI_1/default.jpg">',
    'assets/app.css': '.cover{background:url(https://img.youtube.com/vi/AbCdEfGhI_1/0.jpg)}',
  }, (root) => {
    const violations = inspectProductionTransport(root).violations;
    assert.equal(violations.length, 3);
    assert.ok(violations.every(({ id }) => id === 'direct-provider-image'));
  });
});

test('fails closed for missing, empty, and invalid build paths', () => {
  const missing = path.join(os.tmpdir(), `osg-missing-build-${process.pid}`);
  assert.throws(() => assertProductionTransportBoundary(missing), /directory is missing/);

  withBuild({ 'index.html': '<main></main>' }, (root) => {
    assert.throws(() => assertProductionTransportBoundary(root), /no JavaScript artifacts/);
  });

  withBuild({ 'bundle.js': '0' }, (root) => {
    const file = path.join(root, 'bundle.js');
    assert.throws(() => assertProductionTransportBoundary(file), /not a directory/);
  });
});

test('argument parsing rejects ambiguity', () => {
  assert.throws(() => parseArguments(['--build-directory']), /requires a path/);
  assert.throws(() => parseArguments(['--unknown']), /Unknown argument/);
});
