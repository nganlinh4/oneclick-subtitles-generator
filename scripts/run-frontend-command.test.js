const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parseArguments, runFrontendCommand } = require('./run-frontend-command');
const { tauriFrontendDistOverride } = require('./managed-build-context');
const { readCurrentWindowsProcessIdentity } = require('./windows-process-identity.js');

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
};

const createManagedFixture = (context, group) => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-frontend-wrapper-'));
  context.after(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  const rootId = '1'.repeat(32);
  const leaseId = '2'.repeat(32);
  const { processCreatedUtc: created } = readCurrentWindowsProcessIdentity();
  writeJson(path.join(cacheRoot, '.osg-development-cache.json'), {
    schemaVersion: 1, owner: 'oneclick-subtitles-generator', cacheKind: 'development-cache', rootId,
  });
  const roots = {};
  for (const area of ['cargo', 'frontend', 'apps']) {
    writeJson(path.join(cacheRoot, area, '.osg-cache-area.json'), {
      schemaVersion: 1, owner: 'oneclick-subtitles-generator', rootId, area,
    });
    roots[area] = path.join(cacheRoot, area, group);
    writeJson(path.join(roots[area], '.osg-cache-entry.json'), {
      schemaVersion: 1, owner: 'oneclick-subtitles-generator', rootId, lane: `${area}-${group}`,
    });
    writeJson(path.join(roots[area], '.osg-cache-lease'), {
      schemaVersion: 1, owner: 'oneclick-subtitles-generator', rootId, laneGroup: group,
      leaseId, processId: process.pid, processCreatedUtc: created,
    });
  }
  return {
    environment: {
      CARGO_TARGET_DIR: roots.cargo,
      OSG_DEV_CACHE_ROOT: cacheRoot,
      OSG_FRONTEND_OUT_DIR: path.join(roots.frontend, 'build'),
      OSG_MANAGED_APPLICATION_ROOT: roots.apps,
      OSG_MANAGED_FRONTEND_ROOT: roots.frontend,
      OSG_MANAGED_LANE: group,
      OSG_MANAGED_LEASE_ID: leaseId,
      OSG_MANAGED_LEASE_PROCESS_CREATED_UTC: created,
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

test('frontend wrapper accepts only the canonical dev lane shape', () => {
  assert.deepEqual(parseArguments(['--lane', 'dev', '--', 'npm', 'run', 'build:vite:inner']), {
    command: 'npm', args: ['run', 'build:vite:inner'],
  });
  assert.throws(
    () => parseArguments(['--lane', 'package', '--', 'npm', 'run', 'build:vite:inner']),
    /--lane dev/u,
  );
});

test('an unmanaged public frontend command enters run-managed-command on dev', () => {
  const calls = [];
  runFrontendCommand({
    arguments_: ['--lane', 'dev', '--', 'npm', 'run', 'build:frontend:inner'],
    environment: {
      CARGO_TARGET_DIR: 'C:\\global-cargo-target',
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      KEEP_ME: 'yes',
      TAURI_CONFIG: '{"unmanaged":true}',
    },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args.slice(-7), [
    path.join(path.resolve(__dirname, '..'), 'scripts', 'run-managed-command.js'),
    '--lane', 'dev', '--', 'npm', 'run', 'build:frontend:inner',
  ]);
  assert.equal(calls[0].options.env.KEEP_ME, 'yes');
});

test('an exact existing dev or package lease runs the inner command without nesting', (context) => {
  for (const group of ['dev', 'package']) {
    const fixture = createManagedFixture(context, group);
    const calls = [];
    runFrontendCommand({
      arguments_: ['--lane', 'dev', '--', 'npm', 'run', 'build:vite:inner'],
      environment: fixture.environment,
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    });
    assert.equal(calls.length, 1);
    assert.match(path.basename(calls[0].command), /^npm(?:\.cmd)?$/u);
    assert.deepEqual(calls[0].args, ['run', 'build:vite:inner']);
  }
});

test('partial or forged managed variables fail instead of bypassing or nesting', () => {
  assert.throws(
    () => runFrontendCommand({
      arguments_: ['--lane', 'dev', '--', 'npm', 'run', 'build:vite:inner'],
      environment: { OSG_MANAGED_FRONTEND_ROOT: 'C:\\forged' },
      spawn: () => ({ status: 0 }),
    }),
    /OSG_DEV_CACHE_ROOT/u,
  );
});
