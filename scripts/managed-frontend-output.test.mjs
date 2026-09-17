import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import { loadConfigFromFile } from 'vite';

const require = createRequire(import.meta.url);
const { generateVersionFile } = require('./generate-version.js');
const { tauriFrontendDistOverride } = require('./managed-build-context.js');
const { readCurrentWindowsProcessIdentity } = require('./windows-process-identity.js');

const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`);
};

test('managed frontend build inputs and outputs stay in the leased external lane', async (context) => {
  const cache = mkdtempSync(join(tmpdir(), 'osg-managed-frontend-test-'));
  context.after(() => rmSync(cache, { recursive: true, force: true }));
  const frontendRoot = join(cache, 'frontend', 'dev');
  const promptDj = join(frontendRoot, 'promptdj');
  const output = join(frontendRoot, 'build');
  const viteCache = join(frontendRoot, 'vite-cache');
  const promptDjViteCache = join(frontendRoot, 'promptdj-vite-cache');
  const versionModule = join(frontendRoot, 'version.js');
  mkdirSync(promptDj, { recursive: true });
  const rootId = '1'.repeat(32);
  const leaseId = '2'.repeat(32);
  const { processCreatedUtc } = readCurrentWindowsProcessIdentity();
  const cargoRoot = join(cache, 'cargo', 'dev');
  const applicationRoot = join(cache, 'apps', 'dev');
  writeJson(join(cache, '.osg-development-cache.json'), {
    schemaVersion: 1, owner: 'oneclick-subtitles-generator', cacheKind: 'development-cache', rootId,
  });
  for (const area of ['cargo', 'frontend', 'apps']) {
    writeJson(join(cache, area, '.osg-cache-area.json'), {
      schemaVersion: 1, owner: 'oneclick-subtitles-generator', rootId, area,
    });
  }
  for (const [directory, lane] of [
    [cargoRoot, 'cargo-dev'], [frontendRoot, 'frontend-dev'], [applicationRoot, 'apps-dev'],
  ]) {
    writeJson(join(directory, '.osg-cache-entry.json'), {
      schemaVersion: 1, owner: 'oneclick-subtitles-generator', rootId, lane,
    });
    writeJson(join(directory, '.osg-cache-lease'), {
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId,
    laneGroup: 'dev',
    leaseId,
    processId: process.pid,
      processCreatedUtc,
    });
  }
  const previous = Object.fromEntries([
    'CARGO_TARGET_DIR', 'OSG_DEV_CACHE_ROOT', 'OSG_FRONTEND_OUT_DIR',
    'OSG_MANAGED_APPLICATION_ROOT', 'OSG_MANAGED_FRONTEND_ROOT', 'OSG_MANAGED_LANE',
    'OSG_MANAGED_LEASE_ID', 'OSG_MANAGED_LEASE_PROCESS_CREATED_UTC',
    'OSG_MANAGED_LEASE_PROCESS_ID', 'OSG_PROMPTDJ_OUT_DIR', 'OSG_VERSION_MODULE_PATH',
    'TAURI_CONFIG',
  ].map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    CARGO_TARGET_DIR: cargoRoot,
    OSG_DEV_CACHE_ROOT: cache,
    OSG_MANAGED_APPLICATION_ROOT: applicationRoot,
    OSG_MANAGED_FRONTEND_ROOT: frontendRoot,
    OSG_MANAGED_LANE: 'dev',
    OSG_MANAGED_LEASE_ID: leaseId,
    OSG_MANAGED_LEASE_PROCESS_CREATED_UTC: processCreatedUtc,
    OSG_MANAGED_LEASE_PROCESS_ID: String(process.pid),
    OSG_FRONTEND_OUT_DIR: output,
    OSG_PROMPTDJ_OUT_DIR: promptDj,
    OSG_VERSION_MODULE_PATH: versionModule,
    TAURI_CONFIG: JSON.stringify({
      build: {
        frontendDist: tauriFrontendDistOverride(resolve(import.meta.dirname, '..'), output),
      },
    }),
  });
  context.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  generateVersionFile({
    hash: 'a'.repeat(40),
    shortHash: 'a'.repeat(7),
    date: '2026-08-26T00:00:00.000Z',
    timestamp: 1787702400,
    branch: 'test',
    message: 'managed output',
    author: { name: 'test', email: 'test@example.invalid' },
    isClean: true,
    buildTime: '2026-08-26T00:00:00.000Z',
  });
  assert.equal(existsSync(versionModule), true);
  assert.match(readFileSync(versionModule, 'utf8'), /managed output/u);

  const viteModule = await import(`../vite.config.mjs?managed=${Date.now()}`);
  const config = viteModule.default({ mode: 'production' });
  assert.equal(resolve(config.build.outDir), resolve(output));
  assert.equal(config.build.emptyOutDir, true, 'external builds must not accumulate obsolete chunks');
  assert.equal(resolve(config.cacheDir), resolve(viteCache));
  const versionPlugin = config.plugins.find(
    ({ name }) => name === 'osg-immutable-e2e-version-metadata',
  );
  const virtualId = versionPlugin.resolveId(
    '../config/version.js',
    resolve('src/utils/gitVersion.js'),
  );
  assert.equal(versionPlugin.load(virtualId), readFileSync(versionModule, 'utf8'));

  const promptConfig = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    resolve('promptdj-midi/vite.config.ts'),
  );
  assert.equal(resolve(promptConfig.config.build.outDir), resolve(promptDj));
  assert.equal(resolve(promptConfig.config.cacheDir), resolve(promptDjViteCache));
});
