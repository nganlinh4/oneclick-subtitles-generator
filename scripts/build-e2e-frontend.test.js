const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildE2eFrontendSnapshot,
  parseCacheArgument,
  resolveCacheRoot,
  run,
} = require('./build-e2e-frontend');
const { readCurrentWindowsProcessIdentity } = require('./windows-process-identity.js');

const writeJson = (destination, value) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
};

const managedFrontendLane = (root, leaseId = 'a'.repeat(32)) => {
  const cacheRoot = path.join(root, 'managed-cache', 'frontend', 'e2e');
  const rootId = 'b'.repeat(32);
  fs.mkdirSync(cacheRoot, { recursive: true });
  writeJson(path.join(root, 'managed-cache', 'frontend', '.osg-cache-area.json'), {
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId,
    area: 'frontend',
  });
  writeJson(path.join(cacheRoot, '.osg-cache-entry.json'), {
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId,
    lane: 'frontend-e2e',
  });
  writeJson(path.join(cacheRoot, '.osg-cache-lease'), {
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId,
    laneGroup: 'e2e',
    leaseId,
    processId: process.pid,
    processCreatedUtc: readCurrentWindowsProcessIdentity().processCreatedUtc,
  });
  return Object.freeze({ cacheRoot, leaseId });
};

test('frontend compiler children are assigned to the owner Job Object with the leased lane sentinel', () => {
  const managedPath = path.join(os.tmpdir(), 'osg-frontend-supervisor-sentinel');
  let invocation;
  run(process.execPath, ['-e', 'process.exit(0)'], {
    cwd: path.resolve(__dirname, '..'),
    managedPaths: [managedPath],
    supervise(input) {
      invocation = input;
      return { status: 0 };
    },
  });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.managedPaths, [managedPath]);
  assert.equal(invocation.ownerProcessId, process.pid);
});

test('the frontend builder uses isolated inputs and never mutates production version or build', (context) => {
  const repository = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-e2e-builder-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache');
  const productionVersion = path.join(repository, 'src', 'config', 'version.js');
  const productionBuild = path.join(repository, 'build');
  const versionBefore = fs.readFileSync(productionVersion);
  const buildIndex = path.join(productionBuild, 'index.html');
  const buildBefore = fs.existsSync(buildIndex) ? fs.readFileSync(buildIndex) : null;
  const calls = [];
  const result = buildE2eFrontendSnapshot({
    repositoryRoot: repository,
    cacheRoot: cache,
    runCommand(command, args, options) {
      calls.push({ command, args, options });
      const outIndex = args.indexOf('--outDir');
      if (outIndex < 0) return;
      const output = args[outIndex + 1];
      fs.mkdirSync(output, { recursive: true });
      if (options.cwd === repository) {
        assert.equal(options.env.OSG_E2E_FRONTEND_BUILD, '1');
        assert.ok(path.isAbsolute(options.env.OSG_E2E_VERSION_MODULE));
        assert.match(fs.readFileSync(options.env.OSG_E2E_VERSION_MODULE, 'utf8'), /Object\.freeze/u);
        assert.ok(path.isAbsolute(options.env.OSG_E2E_PROMPTDJ_DIST));
        assert.equal(
          options.env.OSG_E2E_VITE_CACHE_DIR,
          path.join(path.dirname(options.env.OSG_E2E_VERSION_MODULE), 'vite-cache'),
        );
        fs.writeFileSync(path.join(output, 'index.html'), 'isolated frontend');
      } else {
        assert.equal(options.env.OSG_E2E_FRONTEND_BUILD, '1');
        assert.equal(options.env.OSG_E2E_PROMPTDJ_DIST, output);
        assert.equal(
          options.env.OSG_E2E_VITE_CACHE_DIR,
          path.join(path.dirname(output), 'promptdj-vite-cache'),
        );
        fs.writeFileSync(path.join(output, 'index.html'), 'isolated PromptDJ');
      }
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(fs.readFileSync(path.join(result.snapshotRoot, 'index.html'), 'utf8'), 'isolated frontend');
  assert.ok(fs.readFileSync(productionVersion).equals(versionBefore));
  if (buildBefore === null) assert.equal(fs.existsSync(buildIndex), false);
  else assert.ok(fs.readFileSync(buildIndex).equals(buildBefore));
  assert.throws(() => resolveCacheRoot(repository), /explicit cache root/u);
  assert.throws(() => resolveCacheRoot(repository, 'relative/cache'), /must be absolute/u);
  assert.deepEqual(parseCacheArgument([
    '--cache-root', cache,
    '--lease-id', 'a'.repeat(32),
  ]), { cacheRoot: cache, retentionLeaseId: 'a'.repeat(32) });
  assert.throws(() => parseCacheArgument(['--cache-root', cache]), /--lease-id/u);
});

test('the managed builder keeps temporary frontend work inside its exact leased lane', (context) => {
  const repository = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-e2e-managed-builder-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managed = managedFrontendLane(root);
  const outputs = [];
  const result = buildE2eFrontendSnapshot({
    repositoryRoot: repository,
    cacheRoot: managed.cacheRoot,
    retentionLeaseId: managed.leaseId,
    runCommand(_command, args, options) {
      const outIndex = args.indexOf('--outDir');
      if (outIndex < 0) return;
      const output = args[outIndex + 1];
      outputs.push(output);
      assert.ok(output.startsWith(path.join(managed.cacheRoot, '.osg-frontend-workspaces')));
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, 'index.html'), options.cwd === repository ? 'frontend' : 'promptdj');
    },
  });
  assert.equal(outputs.length, 2);
  assert.equal(fs.readFileSync(path.join(result.snapshotRoot, 'index.html'), 'utf8'), 'frontend');
  assert.equal(fs.readdirSync(path.join(managed.cacheRoot, '.osg-frontend-workspaces')).length, 0);
});
