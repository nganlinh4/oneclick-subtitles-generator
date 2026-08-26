const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { assertManagedTauriInvocation } = require('./run-tauri-cli');
const { tauriFrontendDistOverride } = require('./managed-build-context');
const { readCurrentWindowsProcessIdentity } = require('./windows-process-identity.js');

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
};

test('local Tauri entry points require one exact external managed build lease', (context) => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-tauri-guard-'));
  context.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const rootId = '1'.repeat(32);
  const leaseId = '2'.repeat(32);
  const { processCreatedUtc } = readCurrentWindowsProcessIdentity();
  const cargo = path.join(cache, 'cargo', 'package');
  const frontend = path.join(cache, 'frontend', 'package');
  const application = path.join(cache, 'apps', 'package');
  writeJson(path.join(cache, '.osg-development-cache.json'), {
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    cacheKind: 'development-cache',
    rootId,
  });
  for (const area of ['cargo', 'frontend', 'apps']) {
    writeJson(path.join(cache, area, '.osg-cache-area.json'), {
      schemaVersion: 1, owner: 'oneclick-subtitles-generator', rootId, area,
    });
  }
  for (const [directory, lane] of [
    [cargo, 'cargo-package'], [frontend, 'frontend-package'], [application, 'apps-package'],
  ]) {
    writeJson(path.join(directory, '.osg-cache-entry.json'), {
      schemaVersion: 1, owner: 'oneclick-subtitles-generator', rootId, lane,
    });
    writeJson(path.join(directory, '.osg-cache-lease'), {
      schemaVersion: 1,
      owner: 'oneclick-subtitles-generator',
      rootId,
      laneGroup: 'package',
      leaseId,
      processId: process.pid,
      processCreatedUtc,
    });
  }
  const environment = {
    CARGO_TARGET_DIR: cargo,
    OSG_DEV_CACHE_ROOT: cache,
    OSG_FRONTEND_OUT_DIR: path.join(frontend, 'build'),
    OSG_MANAGED_APPLICATION_ROOT: application,
    OSG_MANAGED_FRONTEND_ROOT: frontend,
    OSG_MANAGED_LANE: 'package',
    OSG_MANAGED_LEASE_ID: leaseId,
    OSG_MANAGED_LEASE_PROCESS_CREATED_UTC: processCreatedUtc,
    OSG_MANAGED_LEASE_PROCESS_ID: String(process.pid),
    OSG_PROMPTDJ_OUT_DIR: path.join(frontend, 'promptdj'),
    OSG_VERSION_MODULE_PATH: path.join(frontend, 'version.js'),
    TAURI_CONFIG: JSON.stringify({
      build: {
        frontendDist: tauriFrontendDistOverride(
          path.resolve(__dirname, '..'),
          path.join(frontend, 'build'),
        ),
      },
    }),
  };
  for (const directory of [cargo, frontend, application]) {
    const leaseFile = path.join(directory, '.osg-cache-lease');
    const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
    writeJson(leaseFile, {
      ...lease,
      processId: process.pid,
      processCreatedUtc: environment.OSG_MANAGED_LEASE_PROCESS_CREATED_UTC,
    });
  }
  assert.equal(assertManagedTauriInvocation({ environment }), 'package');
  assert.throws(
    () => assertManagedTauriInvocation({ environment: {} }),
    /must run through the root managed-cache scripts/u,
  );
  assert.throws(
    () => assertManagedTauriInvocation({
      environment: { ...environment, TAURI_CONFIG: '{"build":{"frontendDist":"C:/wrong"}}' },
    }),
    /frontendDist is not the exact relative managed frontend publication/u,
  );
});

test('CI-looking environment variables never bypass the local Tauri guard', () => {
  assert.throws(
    () => assertManagedTauriInvocation({ environment: { CI: 'true', GITHUB_ACTIONS: 'true' } }),
    /must run through the root managed-cache scripts/u,
  );
});
