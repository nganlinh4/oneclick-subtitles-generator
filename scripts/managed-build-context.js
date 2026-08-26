const fs = require('node:fs');
const path = require('node:path');
const { assertWindowsProcessIdentity } = require('./windows-process-identity.js');

const OWNER = 'oneclick-subtitles-generator';
const SCHEMA_VERSION = 1;
const ID_PATTERN = /^[0-9a-f]{32}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const MANAGED_LANES = new Set(['dev', 'package']);
const MANAGED_ENVIRONMENT_KEYS = Object.freeze([
  'CARGO_TARGET_DIR',
  'OSG_DEV_CACHE_ROOT',
  'OSG_FRONTEND_OUT_DIR',
  'OSG_MANAGED_APPLICATION_ROOT',
  'OSG_MANAGED_FRONTEND_ROOT',
  'OSG_MANAGED_LANE',
  'OSG_MANAGED_LEASE_ID',
  'OSG_MANAGED_LEASE_PROCESS_CREATED_UTC',
  'OSG_MANAGED_LEASE_PROCESS_ID',
  'OSG_PROMPTDJ_OUT_DIR',
  'OSG_VERSION_MODULE_PATH',
  'TAURI_CONFIG',
]);

const samePath = (left, right) => (
  process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right)
);

// Tauri parses `frontendDist` as a URL before treating it as a directory. An absolute Windows
// path such as `C:\x` parses with its drive letter as the URL scheme, becomes
// `FrontendDist::Url`, and then codegen embeds NO assets while the built application navigates
// its main window to a file:// directory listing of that path — where the first IPC message
// aborts the process inside wry. The override must therefore stay a relative directory, which
// Tauri resolves against apps/desktop/src-tauri.
const TAURI_CONFIG_DIRECTORY = Object.freeze(['apps', 'desktop', 'src-tauri']);
const tauriFrontendDistOverride = (repositoryRoot, frontendBuildDirectory) => {
  const tauriDirectory = path.join(path.resolve(repositoryRoot), ...TAURI_CONFIG_DIRECTORY);
  const relative = path.relative(tauriDirectory, path.resolve(frontendBuildDirectory));
  if (relative === '' || path.isAbsolute(relative)) {
    throw new Error(
      'the managed frontend publication must share a volume with apps/desktop/src-tauri '
      + 'so the Tauri frontendDist override stays a relative directory',
    );
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(relative.replaceAll('\\', '/'))) {
    throw new Error('the Tauri frontendDist override must not parse as a URL');
  }
  return relative;
};

const containsOrEquals = (left, right) => {
  const relative = path.relative(path.resolve(left), path.resolve(right));
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const overlaps = (left, right) => containsOrEquals(left, right) || containsOrEquals(right, left);

const assertExactKeys = (value, expected, label) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain one JSON object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an unexpected schema`);
  }
};

const readPrivateJson = (file, label) => {
  const status = fs.lstatSync(file);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error(`${label} must be one private regular file`);
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  return value;
};

const assertRealDirectory = (directory, label) => {
  const status = fs.lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${label} must be one real directory`);
  }
};

const assertSafeOptionalOutput = (target, kind, label) => {
  if (!fs.existsSync(target)) return;
  const status = fs.lstatSync(target);
  if (
    status.isSymbolicLink()
    || (kind === 'directory' ? !status.isDirectory() : !status.isFile())
    || (kind === 'file' && status.nlink !== 1)
  ) {
    throw new Error(`${label} must remain one private real ${kind}`);
  }
};

const requiredAbsolutePath = (environment, name) => {
  const value = environment[name];
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path from the managed build contract`);
  }
  return path.resolve(value);
};

const hasManagedBuildHint = (environment = process.env) => MANAGED_ENVIRONMENT_KEYS
  .some((name) => environment[name] !== undefined);
const hasManagedLeaseIdentity = (environment = process.env) => [
  'OSG_MANAGED_FRONTEND_ROOT',
  'OSG_MANAGED_LANE',
  'OSG_MANAGED_LEASE_ID',
].some((name) => environment[name] !== undefined);

const defaultProcessAlive = (processId) => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    return false;
  }
};

const assertManagedBuildInvocation = ({
  environment = process.env,
  repositoryRoot = path.resolve(__dirname, '..'),
  isProcessAlive = defaultProcessAlive,
  assertProcessIdentity = assertWindowsProcessIdentity,
} = {}) => {
  const repository = path.resolve(repositoryRoot);
  const cacheRoot = requiredAbsolutePath(environment, 'OSG_DEV_CACHE_ROOT');
  const cargoRoot = requiredAbsolutePath(environment, 'CARGO_TARGET_DIR');
  const frontendRoot = requiredAbsolutePath(environment, 'OSG_MANAGED_FRONTEND_ROOT');
  const applicationRoot = requiredAbsolutePath(environment, 'OSG_MANAGED_APPLICATION_ROOT');
  const group = environment.OSG_MANAGED_LANE;
  if (!MANAGED_LANES.has(group)) {
    throw new Error('OSG_MANAGED_LANE must identify the exact dev or package lease');
  }
  if (
    !samePath(cargoRoot, path.join(cacheRoot, 'cargo', group))
    || !samePath(frontendRoot, path.join(cacheRoot, 'frontend', group))
    || !samePath(applicationRoot, path.join(cacheRoot, 'apps', group))
    || overlaps(repository, cacheRoot)
  ) {
    throw new Error('Managed build output overlaps the repository or has an invalid cache shape');
  }

  for (const [directory, label] of [
    [cacheRoot, 'development cache root'],
    [path.join(cacheRoot, 'cargo'), 'Cargo cache area'],
    [path.join(cacheRoot, 'frontend'), 'frontend cache area'],
    [path.join(cacheRoot, 'apps'), 'application cache area'],
    [cargoRoot, 'Cargo lane'],
    [frontendRoot, 'frontend lane'],
    [applicationRoot, 'application lane'],
  ]) {
    assertRealDirectory(directory, label);
  }

  const rootMarker = readPrivateJson(
    path.join(cacheRoot, '.osg-development-cache.json'),
    'development cache marker',
  );
  assertExactKeys(rootMarker, ['schemaVersion', 'owner', 'cacheKind', 'rootId'], 'development cache marker');
  if (
    rootMarker.schemaVersion !== SCHEMA_VERSION
    || rootMarker.owner !== OWNER
    || rootMarker.cacheKind !== 'development-cache'
    || !ID_PATTERN.test(rootMarker.rootId ?? '')
  ) {
    throw new Error('Development cache marker has a foreign identity');
  }

  for (const area of ['cargo', 'frontend', 'apps']) {
    const marker = readPrivateJson(
      path.join(cacheRoot, area, '.osg-cache-area.json'),
      `${area} cache area marker`,
    );
    assertExactKeys(marker, ['schemaVersion', 'owner', 'rootId', 'area'], `${area} cache area marker`);
    if (
      marker.schemaVersion !== SCHEMA_VERSION
      || marker.owner !== OWNER
      || marker.rootId !== rootMarker.rootId
      || marker.area !== area
    ) {
      throw new Error(`${area} cache area marker has a foreign identity`);
    }
  }

  const leases = [];
  for (const [directory, lane] of [
    [cargoRoot, `cargo-${group}`],
    [frontendRoot, `frontend-${group}`],
    [applicationRoot, `apps-${group}`],
  ]) {
    const entry = readPrivateJson(path.join(directory, '.osg-cache-entry.json'), `${lane} marker`);
    assertExactKeys(entry, ['schemaVersion', 'owner', 'rootId', 'lane'], `${lane} marker`);
    if (
      entry.schemaVersion !== SCHEMA_VERSION
      || entry.owner !== OWNER
      || entry.rootId !== rootMarker.rootId
      || entry.lane !== lane
    ) {
      throw new Error(`${lane} marker has a foreign identity`);
    }
    const lease = readPrivateJson(path.join(directory, '.osg-cache-lease'), `${lane} lease`);
    assertExactKeys(
      lease,
      ['schemaVersion', 'owner', 'rootId', 'laneGroup', 'leaseId', 'processId', 'processCreatedUtc'],
      `${lane} lease`,
    );
    leases.push(lease);
  }

  const processId = Number(environment.OSG_MANAGED_LEASE_PROCESS_ID);
  const processCreatedUtc = environment.OSG_MANAGED_LEASE_PROCESS_CREATED_UTC;
  const leaseId = environment.OSG_MANAGED_LEASE_ID;
  if (
    !ID_PATTERN.test(leaseId ?? '')
    || !Number.isSafeInteger(processId)
    || processId < 1
    || typeof processCreatedUtc !== 'string'
    || Number.isNaN(Date.parse(processCreatedUtc))
    || leases.some((lease) => (
      lease.schemaVersion !== SCHEMA_VERSION
      || lease.owner !== OWNER
      || lease.rootId !== rootMarker.rootId
      || lease.laneGroup !== group
      || lease.leaseId !== leaseId
      || lease.processId !== processId
      || lease.processCreatedUtc !== processCreatedUtc
    ))
  ) {
    throw new Error('Managed build lanes are not covered by one exact shared lease contract');
  }
  if (!isProcessAlive(processId)) {
    throw new Error('Managed build lease owner is no longer alive');
  }
  try {
    assertProcessIdentity({ processId, processCreatedUtc });
  } catch (error) {
    throw new Error('Managed build lease owner identity is stale or was reused', { cause: error });
  }

  const expectedFrontend = path.join(frontendRoot, 'build');
  const expectedPromptDj = path.join(frontendRoot, 'promptdj');
  const expectedVersion = path.join(frontendRoot, 'version.js');
  for (const [target, kind, label] of [
    [expectedFrontend, 'directory', 'managed frontend output'],
    [expectedPromptDj, 'directory', 'managed PromptDJ output'],
    [expectedVersion, 'file', 'managed version module'],
    [path.join(frontendRoot, 'vite-cache'), 'directory', 'managed Vite dependency cache'],
    [path.join(frontendRoot, 'promptdj-vite-cache'), 'directory', 'managed PromptDJ dependency cache'],
  ]) {
    assertSafeOptionalOutput(target, kind, label);
  }
  for (const [name, expected] of [
    ['OSG_FRONTEND_OUT_DIR', expectedFrontend],
    ['OSG_PROMPTDJ_OUT_DIR', expectedPromptDj],
    ['OSG_VERSION_MODULE_PATH', expectedVersion],
  ]) {
    if (!path.isAbsolute(environment[name] ?? '') || !samePath(environment[name], expected)) {
      throw new Error(`${name} is not the exact child of the leased frontend lane`);
    }
  }
  let override;
  try {
    override = JSON.parse(environment.TAURI_CONFIG ?? 'null');
  } catch (error) {
    throw new Error('TAURI_CONFIG is not valid JSON', { cause: error });
  }
  const overrideDist = override?.build?.frontendDist;
  if (typeof overrideDist !== 'string'
    || overrideDist !== tauriFrontendDistOverride(repository, expectedFrontend)) {
    throw new Error('Tauri frontendDist is not the exact relative managed frontend publication');
  }
  return Object.freeze({
    applicationRoot,
    cacheRoot,
    cargoRoot,
    frontendRoot,
    group,
    leaseId,
  });
};

const assertGitHubActionsIdentity = ({
  environment = process.env,
  repositoryRoot = path.resolve(__dirname, '..'),
} = {}) => {
  const workspace = environment.GITHUB_WORKSPACE;
  const runnerTemp = environment.RUNNER_TEMP;
  if (
    environment.CI !== 'true'
    || environment.GITHUB_ACTIONS !== 'true'
    || typeof workspace !== 'string'
    || !path.isAbsolute(workspace)
    || !samePath(workspace, repositoryRoot)
    || typeof runnerTemp !== 'string'
    || !path.isAbsolute(runnerTemp)
    || overlaps(repositoryRoot, runnerTemp)
    || !/^\d+$/u.test(environment.GITHUB_RUN_ID ?? '')
    || !/^[1-9]\d*$/u.test(environment.GITHUB_RUN_ATTEMPT ?? '')
    || !/^[A-Za-z0-9_.-]+$/u.test(environment.GITHUB_JOB ?? '')
    || !SHA_PATTERN.test(environment.GITHUB_SHA ?? '')
    || !['Linux', 'macOS', 'Windows'].includes(environment.RUNNER_OS)
  ) {
    throw new Error('Direct frontend build is reserved for one validated GitHub Actions workspace');
  }
  return 'github-actions';
};

const assertFrontendInnerInvocation = (options = {}) => {
  const environment = options.environment ?? process.env;
  if (hasManagedLeaseIdentity(environment)) {
    return assertManagedBuildInvocation({ ...options, environment }).group;
  }
  if (environment.CI !== undefined || environment.GITHUB_ACTIONS !== undefined) {
    return assertGitHubActionsIdentity({ ...options, environment });
  }
  if (hasManagedBuildHint(environment)) {
    return assertManagedBuildInvocation(options).group;
  }
  return assertGitHubActionsIdentity({ ...options, environment });
};

module.exports = {
  MANAGED_ENVIRONMENT_KEYS,
  assertFrontendInnerInvocation,
  assertGitHubActionsIdentity,
  assertManagedBuildInvocation,
  hasManagedBuildHint,
  hasManagedLeaseIdentity,
  overlaps,
  readPrivateJson,
  samePath,
  tauriFrontendDistOverride,
};
