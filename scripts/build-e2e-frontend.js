#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runSupervisedSync } = require('./windows-job-supervisor');

const {
  collectStrictReproducibleGitInfo,
  renderVersionModule,
} = require('./e2e-build-metadata');
const {
  createManagedFrontendWorkspace,
  publishFrontendSnapshot,
  releaseManagedFrontendWorkspace,
  resolveAbsoluteInput,
} = require('./e2e-frontend-snapshot');

const run = (command, args, options) => {
  const supervise = options.supervise ?? runSupervisedSync;
  const result = supervise({
    command,
    args,
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
    ownerProcessId: process.pid,
    managedPaths: options.managedPaths,
    spawn: options.spawn ?? spawnSync,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.join(' ')} exited with ${result.status}`);
  }
};

const resolveCacheRoot = (_repositoryRoot, explicit) => {
  if (explicit === undefined || explicit === '') {
    throw new Error(
      'E2E frontend publication requires the explicit cache root returned by the managed build lease',
    );
  }
  return resolveAbsoluteInput(explicit, 'managed E2E frontend cache root');
};

const buildE2eFrontendSnapshot = ({
  repositoryRoot = path.resolve(__dirname, '..'),
  cacheRoot,
  retentionLeaseId,
  runCommand = run,
} = {}) => {
  const repository = resolveAbsoluteInput(repositoryRoot, 'repository root');
  const cache = resolveCacheRoot(repository, cacheRoot);
  if (retentionLeaseId === undefined && process.env.NODE_TEST_CONTEXT === undefined) {
    throw new Error('E2E frontend work requires the exact active managed frontend lease');
  }
  const managedWorkspace = retentionLeaseId === undefined
    ? null
    : createManagedFrontendWorkspace({ cacheRoot: cache, retentionLeaseId });
  const workRoot = managedWorkspace?.workspaceRoot
    ?? fs.mkdtempSync(path.join(os.tmpdir(), 'osg-e2e-frontend-build-'));
  const promptDjDist = path.join(workRoot, 'promptdj');
  const frontendDist = path.join(workRoot, 'frontend');
  const versionModule = path.join(workRoot, 'version.js');
  const promptDjViteCache = path.join(workRoot, 'promptdj-vite-cache');
  const frontendViteCache = path.join(workRoot, 'vite-cache');
  const viteEntry = path.join(repository, 'node_modules', 'vite', 'bin', 'vite.js');
  const tscEntry = path.join(repository, 'node_modules', 'typescript', 'bin', 'tsc');
  let primaryError;
  try {
    const versionInfo = collectStrictReproducibleGitInfo({ repositoryRoot: repository });
    fs.writeFileSync(versionModule, renderVersionModule(versionInfo), { flag: 'wx' });
    runCommand(process.execPath, [tscEntry, '--noEmit'], {
      cwd: path.join(repository, 'promptdj-midi'),
      managedPaths: [cache],
    });
    runCommand(process.execPath, [viteEntry, 'build', '--outDir', promptDjDist, '--emptyOutDir'], {
      cwd: path.join(repository, 'promptdj-midi'),
      env: {
        ...process.env,
        OSG_E2E_FRONTEND_BUILD: '1',
        OSG_E2E_PROMPTDJ_DIST: promptDjDist,
        OSG_E2E_VERSION_MODULE: versionModule,
        OSG_E2E_VITE_CACHE_DIR: promptDjViteCache,
      },
      managedPaths: [cache],
    });
    runCommand(process.execPath, [
      viteEntry,
      'build',
      '--config', 'vite.config.mjs',
      '--outDir', frontendDist,
      '--emptyOutDir',
    ], {
      cwd: repository,
      env: {
        ...process.env,
        OSG_E2E_FRONTEND_BUILD: '1',
        OSG_E2E_PROMPTDJ_DIST: promptDjDist,
        OSG_E2E_VERSION_MODULE: versionModule,
        OSG_E2E_VITE_CACHE_DIR: frontendViteCache,
      },
      managedPaths: [cache],
    });
    return publishFrontendSnapshot({
      sourceRoot: frontendDist,
      cacheRoot: cache,
      retentionLeaseId,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (managedWorkspace === null) fs.rmSync(workRoot, { recursive: true, force: true });
      else releaseManagedFrontendWorkspace(managedWorkspace);
    } catch (error) {
      if (primaryError === undefined) throw error;
      primaryError.cleanupErrors = [...(primaryError.cleanupErrors ?? []), error];
    }
  }
};

const parseCacheArgument = (argv) => {
  if (argv.length !== 4 || argv[0] !== '--cache-root' || argv[2] !== '--lease-id') {
    throw new Error(
      'usage: build-e2e-frontend.js --cache-root MANAGED_ABSOLUTE_ROOT --lease-id EXACT_ACTIVE_LEASE_ID',
    );
  }
  if (!/^[0-9a-f]{32}$/u.test(argv[3])) {
    throw new Error('build-e2e-frontend.js requires the exact lowercase managed lease id');
  }
  return Object.freeze({ cacheRoot: argv[1], retentionLeaseId: argv[3] });
};

if (require.main === module) {
  try {
    const result = buildE2eFrontendSnapshot(parseCacheArgument(process.argv.slice(2)));
    process.stdout.write(`E2E frontend snapshot ${result.snapshotHash}\n${result.snapshotRoot}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildE2eFrontendSnapshot,
  parseCacheArgument,
  resolveCacheRoot,
  run,
};
