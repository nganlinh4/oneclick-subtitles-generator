import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { defineConfig, loadEnv, transformWithOxc } from 'vite';

import { createFrozenCssCompatibilityPlugin } from './scripts/frozen-css-compatibility.mjs';
import {
  FRONTEND_CHUNK_WARNING_LIMIT_KB,
  createFrontendBundleBoundaryPlugin,
  createFrontendCodeSplitting,
  handleFrontendBuildLog,
} from './scripts/frontend-bundle-boundary.mjs';
import { createRemotionDesktopBoundaryPlugin } from './scripts/remotion-desktop-boundary.mjs';

const sourceJavaScriptPattern = /[/\\]src[/\\].+\.js$/;
const allowedPublicEnvironmentKeys = new Set([
  'REACT_APP_BUILD_TIME',
  'REACT_APP_GIT_BRANCH',
  'REACT_APP_GIT_COMMIT_DATE',
  'REACT_APP_GIT_COMMIT_HASH',
  'REACT_APP_GIT_COMMIT_SHORT_HASH',
  'REACT_APP_GIT_COMMIT_TIMESTAMP',
  'REACT_APP_GIT_IS_CLEAN',
  'REACT_APP_GIT_VERSION',
]);
const ignoredLegacyEnvironmentKeys = new Set([
  'REACT_APP_API_BASE_URL',
  'REACT_APP_BACKEND_PORT',
  'REACT_APP_CHATTERBOX_PORT',
  'REACT_APP_FRONTEND_PORT',
  'REACT_APP_FW_LARGE_V3_PORT',
  'REACT_APP_FW_TURBO_PORT',
  'REACT_APP_NARRATION_PORT',
  'REACT_APP_NODE_ENV',
  'REACT_APP_PARAKEET_PORT',
  'REACT_APP_PROMPTDJ_MIDI_PORT',
  'REACT_APP_QWEN3_ASR_06B_PORT',
  'REACT_APP_QWEN3_ASR_17B_PORT',
  'REACT_APP_SERVER_URL',
  'REACT_APP_VIDEO_RENDERER_FRONTEND_PORT',
  'REACT_APP_VIDEO_RENDERER_PORT',
  'REACT_APP_WEBSOCKET_PORT',
]);
const promptDjDist = resolve('promptdj-midi/dist');
const promptDjContentTypes = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.otf': 'font/otf',
  '.svg': 'image/svg+xml',
});

const productionDesktopModuleMap = new Map([
  [
    resolve('src/services/gemini/keyManager.js'),
    resolve('src/platform/desktopGeminiKeyManager.js'),
  ],
]);

const productionDesktopModules = () => ({
  name: 'osg-production-desktop-modules',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return null;
    const importerPath = importer.split('?')[0];
    const base = resolve(dirname(importerPath), source);
    for (const candidate of [base, `${base}.js`, resolve(base, 'index.js')]) {
      const replacement = productionDesktopModuleMap.get(candidate);
      if (replacement) return replacement;
    }
    return null;
  },
});

const reactJsxInJavaScript = () => ({
  name: 'osg-react-jsx-in-javascript',
  enforce: 'pre',
  async transform(source, id) {
    if (!sourceJavaScriptPattern.test(id)) return null;

    return transformWithOxc(source, id, {
      lang: 'jsx',
      jsx: {
        importSource: 'react',
        runtime: 'automatic',
      },
      sourcemap: true,
    });
  },
});

// The production renderer is embedded exclusively in Tauri. Folding this host
// check at build time lets Rolldown prove that legacy browser transports are
// unreachable and omit them, instead of shipping dormant credential/network
// code in the desktop webview. Development and Vitest retain runtime detection.
const foldProductionDesktopBranches = () => ({
  name: 'osg-fold-production-desktop-branches',
  enforce: 'pre',
  transform(source, id) {
    if (!sourceJavaScriptPattern.test(id) || !source.includes('isDesktopRuntime')) return null;
    const code = source.replace(/\bisDesktopRuntime\s*\(\s*\)/g, 'true');
    return code === source ? null : { code, map: null };
  },
});

const promptDjAssets = () => {
  let frontendOutDir;
  const requireBuild = () => {
    if (!existsSync(resolve(promptDjDist, 'index.html'))) {
      throw new Error('PromptDJ assets are missing; run the promptdj-midi workspace build first.');
    }
  };
  return {
    name: 'osg-promptdj-assets',
    configResolved(config) {
      frontendOutDir = resolve(config.root, config.build.outDir);
    },
    buildStart() {
      requireBuild();
    },
    closeBundle() {
      cpSync(promptDjDist, resolve(frontendOutDir, 'promptdj'), {
        recursive: true,
        force: true,
      });
    },
    configureServer(server) {
      server.middlewares.use('/promptdj', (request, response, next) => {
        try {
          const pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
          const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
          let candidate = resolve(promptDjDist, requested);
          const withinDist = relative(promptDjDist, candidate);
          if (withinDist.startsWith('..') || resolve(promptDjDist, withinDist) !== candidate) {
            response.statusCode = 403;
            response.end();
            return;
          }
          if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            candidate = resolve(candidate, 'index.html');
          }
          if (!existsSync(candidate) || !statSync(candidate).isFile()) {
            next();
            return;
          }
          response.statusCode = 200;
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader(
            'Content-Type',
            promptDjContentTypes[extname(candidate).toLowerCase()] || 'application/octet-stream'
          );
          response.end(readFileSync(candidate));
        } catch {
          response.statusCode = 400;
          response.end();
        }
      });
    },
  };
};

export const selectPublicFrontendEnvironment = (loaded, mode) => {
  const unexpected = Object.keys(loaded).filter((key) => (
    !allowedPublicEnvironmentKeys.has(key) && !ignoredLegacyEnvironmentKeys.has(key)
  ));
  if (unexpected.length > 0) {
    throw new Error(
      `Refusing to expose unreviewed frontend environment variables: ${unexpected.sort().join(', ')}`
    );
  }
  return Object.freeze({
    NODE_ENV: mode === 'production' ? 'production' : 'development',
    ...Object.fromEntries(Object.entries(loaded).filter(([key]) => allowedPublicEnvironmentKeys.has(key))),
  });
};

const publicFrontendEnvironment = (mode) => selectPublicFrontendEnvironment(
  loadEnv(mode, process.cwd(), 'REACT_APP_'),
  mode,
);

export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    chunkSizeWarningLimit: FRONTEND_CHUNK_WARNING_LIMIT_KB,
    // Preserve CRA's handling of the frozen legacy transition grammar while the CSS is ported.
    cssMinify: 'esbuild',
    outDir: 'build',
    rolldownOptions: {
      onLog: handleFrontendBuildLog,
      output: {
        // Keep stable third-party code cacheable without reordering or splitting frozen CSS.
        codeSplitting: createFrontendCodeSplitting(),
      },
    },
    sourcemap: false,
    target: 'es2022',
  },
  define: {
    'process.env': JSON.stringify(publicFrontendEnvironment(mode)),
  },
  esbuild: {
    jsx: 'automatic',
  },
  optimizeDeps: {
    entries: ['index.html'],
    rolldownOptions: {
      moduleTypes: {
        '.js': 'jsx',
      },
    },
  },
  plugins: [
    createFrozenCssCompatibilityPlugin(),
    ...(mode === 'production'
      ? [productionDesktopModules(), foldProductionDesktopBranches()]
      : []),
    reactJsxInJavaScript(),
    createRemotionDesktopBoundaryPlugin(),
    createFrontendBundleBoundaryPlugin(),
    promptDjAssets(),
  ],
  server: {
    host: '127.0.0.1',
    port: 3030,
    strictPort: true,
  },
}));
