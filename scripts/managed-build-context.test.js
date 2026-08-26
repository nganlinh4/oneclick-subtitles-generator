const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertFrontendInnerInvocation,
  assertGitHubActionsIdentity,
  assertManagedBuildInvocation,
  tauriFrontendDistOverride,
} = require('./managed-build-context');
const { readCurrentWindowsProcessIdentity } = require('./windows-process-identity.js');

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
};

const createManagedFixture = (context, group = 'dev') => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-build-context-'));
  context.after(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  const rootId = '1'.repeat(32);
  const leaseId = '2'.repeat(32);
  const { processCreatedUtc } = readCurrentWindowsProcessIdentity();
  writeJson(path.join(cacheRoot, '.osg-development-cache.json'), {
    schemaVersion: 1, owner: 'oneclick-subtitles-generator', cacheKind: 'development-cache', rootId,
  });
  for (const area of ['cargo', 'frontend', 'apps']) {
    writeJson(path.join(cacheRoot, area, '.osg-cache-area.json'), {
      schemaVersion: 1, owner: 'oneclick-subtitles-generator', rootId, area,
    });
  }
  const roots = {
    cargo: path.join(cacheRoot, 'cargo', group),
    frontend: path.join(cacheRoot, 'frontend', group),
    apps: path.join(cacheRoot, 'apps', group),
  };
  for (const [area, directory] of Object.entries(roots)) {
    writeJson(path.join(directory, '.osg-cache-entry.json'), {
      schemaVersion: 1,
      owner: 'oneclick-subtitles-generator',
      rootId,
      lane: `${area === 'apps' ? 'apps' : area}-${group}`,
    });
    writeJson(path.join(directory, '.osg-cache-lease'), {
      schemaVersion: 1,
      owner: 'oneclick-subtitles-generator',
      rootId,
      laneGroup: group,
      leaseId,
      processId: process.pid,
      processCreatedUtc,
    });
  }
  return {
    cacheRoot,
    roots,
    environment: {
      CARGO_TARGET_DIR: roots.cargo,
      OSG_DEV_CACHE_ROOT: cacheRoot,
      OSG_FRONTEND_OUT_DIR: path.join(roots.frontend, 'build'),
      OSG_MANAGED_APPLICATION_ROOT: roots.apps,
      OSG_MANAGED_FRONTEND_ROOT: roots.frontend,
      OSG_MANAGED_LANE: group,
      OSG_MANAGED_LEASE_ID: leaseId,
      OSG_MANAGED_LEASE_PROCESS_CREATED_UTC: processCreatedUtc,
      OSG_MANAGED_LEASE_PROCESS_ID: String(process.pid),
      OSG_PROMPTDJ_OUT_DIR: path.join(roots.frontend, 'promptdj'),
      OSG_VERSION_MODULE_PATH: path.join(roots.frontend, 'version.js'),
      TAURI_CONFIG: JSON.stringify({
        build: {
          frontendDist: tauriFrontendDistOverride(
            path.resolve(__dirname, '..'),
            path.join(roots.frontend, 'build'),
          ),
        },
      }),
    },
  };
};

test('managed frontend and Tauri work require the exact three-lane shared lease', (context) => {
  const fixture = createManagedFixture(context, 'package');
  assert.equal(assertManagedBuildInvocation({ environment: fixture.environment }).group, 'package');
  assert.equal(assertFrontendInnerInvocation({ environment: fixture.environment }), 'package');
  assert.equal(assertFrontendInnerInvocation({
    environment: { ...fixture.environment, CI: 'true', GITHUB_ACTIONS: 'true' },
  }), 'package');

  for (const [name, value, expected] of [
    ['OSG_MANAGED_LEASE_ID', '3'.repeat(32), /one exact shared lease/u],
    ['OSG_PROMPTDJ_OUT_DIR', path.join(fixture.roots.frontend, 'wrong'), /exact child/u],
    ['OSG_MANAGED_APPLICATION_ROOT', path.join(fixture.cacheRoot, 'apps', 'dev'), /invalid cache shape/u],
    // An absolute Windows path parses as a URL (drive-letter scheme): Tauri then embeds no assets
    // and the built app opens a file:// directory listing, so the guard must refuse it.
    [
      'TAURI_CONFIG',
      JSON.stringify({ build: { frontendDist: path.join(fixture.roots.frontend, 'build') } }),
      /relative managed frontend/u,
    ],
  ]) {
    assert.throws(
      () => assertManagedBuildInvocation({
        environment: { ...fixture.environment, [name]: value },
      }),
      expected,
    );
  }
  assert.throws(
    () => assertManagedBuildInvocation({
      environment: fixture.environment,
      isProcessAlive: () => false,
    }),
    /owner is no longer alive/u,
  );

  fs.writeFileSync(fixture.environment.OSG_VERSION_MODULE_PATH, 'export default {};\n');
  fs.linkSync(
    fixture.environment.OSG_VERSION_MODULE_PATH,
    path.join(fixture.roots.frontend, 'version-hardlink.js'),
  );
  assert.throws(
    () => assertManagedBuildInvocation({ environment: fixture.environment }),
    /managed version module must remain one private real file/u,
  );
});

test('foreign, incomplete, and schema-expanded marker files fail closed', (context) => {
  const fixture = createManagedFixture(context);
  const cargoLease = path.join(fixture.roots.cargo, '.osg-cache-lease');
  const original = JSON.parse(fs.readFileSync(cargoLease, 'utf8'));
  writeJson(cargoLease, { ...original, unexpected: true });
  assert.throws(
    () => assertManagedBuildInvocation({ environment: fixture.environment }),
    /unexpected schema/u,
  );
  writeJson(cargoLease, original);
  fs.rmSync(path.join(fixture.roots.apps, '.osg-cache-lease'));
  assert.throws(
    () => assertManagedBuildInvocation({ environment: fixture.environment }),
    /ENOENT/u,
  );
});

test('the two easy-to-spoof CI flags never authorize a direct frontend build', () => {
  assert.throws(
    () => assertGitHubActionsIdentity({ environment: { CI: 'true', GITHUB_ACTIONS: 'true' } }),
    /validated GitHub Actions workspace/u,
  );
  assert.throws(
    () => assertFrontendInnerInvocation({ environment: { CI: 'true', GITHUB_ACTIONS: 'true' } }),
    /validated GitHub Actions workspace/u,
  );
});

test('the CI-only inner route validates the complete GitHub runner identity', () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  const environment = {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_JOB: 'native-matrix',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '123456789',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKSPACE: repositoryRoot,
    RUNNER_OS: 'Windows',
    RUNNER_TEMP: path.join(os.tmpdir(), 'osg-github-runner-temp'),
  };
  assert.equal(assertGitHubActionsIdentity({ environment, repositoryRoot }), 'github-actions');
  assert.equal(assertFrontendInnerInvocation({ environment, repositoryRoot }), 'github-actions');
  assert.throws(
    () => assertGitHubActionsIdentity({
      environment: { ...environment, GITHUB_WORKSPACE: path.join(repositoryRoot, 'forged') },
      repositoryRoot,
    }),
    /validated GitHub Actions workspace/u,
  );
});

module.exports = { createManagedFixture };
