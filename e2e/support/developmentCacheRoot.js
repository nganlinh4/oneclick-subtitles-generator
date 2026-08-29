import { existsSync, realpathSync } from 'node:fs';
import {
  basename, dirname, isAbsolute, join, parse, relative, resolve, sep,
} from 'node:path';
import process from 'node:process';

const DEVELOPMENT_CACHE_DIRECTORY = join('OSG-Development', 'cache');
const WINDOWS_SEPARATOR = '\\';
const WINDOWS_DEVICE_PREFIXES = Object.freeze([
  `${WINDOWS_SEPARATOR}${WINDOWS_SEPARATOR}?${WINDOWS_SEPARATOR}`,
  `${WINDOWS_SEPARATOR}${WINDOWS_SEPARATOR}.${WINDOWS_SEPARATOR}`,
  `${WINDOWS_SEPARATOR}??${WINDOWS_SEPARATOR}`,
  `${WINDOWS_SEPARATOR}${WINDOWS_SEPARATOR}??${WINDOWS_SEPARATOR}`,
  `${WINDOWS_SEPARATOR}device${WINDOWS_SEPARATOR}`,
  `${WINDOWS_SEPARATOR}${WINDOWS_SEPARATOR}device${WINDOWS_SEPARATOR}`,
  `${WINDOWS_SEPARATOR}global??${WINDOWS_SEPARATOR}`,
  `${WINDOWS_SEPARATOR}${WINDOWS_SEPARATOR}global??${WINDOWS_SEPARATOR}`,
]);

const sameCanonicalPath = (left, right) => (
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
);

const sameOrChildPath = (candidate, parent) => {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  return pathFromParent === '' || (
    pathFromParent !== '..'
    && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent)
  );
};

const canonicalizeExistingPrefix = (input) => {
  const suffix = [];
  let existing = resolve(input);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync.native(existing), ...suffix);
};

/** Resolve the external development-cache root without loading any application publication. */
export const resolveDevelopmentCacheRoot = ({
  environment = process.env,
  localApplicationData = environment.LOCALAPPDATA,
  repositoryRoot,
} = {}) => {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.trim().length === 0) {
    throw new Error('The repository root is required to resolve the managed E2E cache');
  }
  const explicit = typeof environment.OSG_DEV_CACHE_ROOT === 'string'
    && environment.OSG_DEV_CACHE_ROOT.trim().length > 0
    ? environment.OSG_DEV_CACHE_ROOT
    : null;
  if (explicit === null && (
    typeof localApplicationData !== 'string' || localApplicationData.trim().length === 0
  )) {
    throw new Error('LOCALAPPDATA is unavailable, so the managed E2E cache cannot be located');
  }
  const requested = explicit ?? join(localApplicationData, DEVELOPMENT_CACHE_DIRECTORY);
  const windowsPath = String(requested).replaceAll('/', WINDOWS_SEPARATOR).toLowerCase();
  if (
    !isAbsolute(requested)
    || String(requested).split(/[\\/]+/u).some((segment) => segment === '.' || segment === '..')
    || WINDOWS_DEVICE_PREFIXES.some((prefix) => windowsPath.startsWith(prefix))
    || String(requested).replaceAll('/', WINDOWS_SEPARATOR).split(WINDOWS_SEPARATOR)
      .some((segment) => segment.length > 0 && /[. ]$/u.test(segment))
  ) {
    throw new Error(`The managed E2E cache must be an absolute path without traversal: ${requested}`);
  }
  const root = resolve(requested);
  if (root === parse(root).root) {
    throw new Error(`The managed E2E cache cannot be a filesystem root: ${root}`);
  }
  const canonicalRoot = canonicalizeExistingPrefix(root);
  if (!sameCanonicalPath(canonicalRoot, root)) {
    throw new Error(`The managed E2E cache crosses a redirected filesystem path: ${root}`);
  }
  const canonicalRepository = realpathSync.native(resolve(repositoryRoot));
  if (
    sameOrChildPath(canonicalRoot, canonicalRepository)
    || sameOrChildPath(canonicalRepository, canonicalRoot)
  ) {
    throw new Error(`The managed E2E cache must be external to the repository: ${root}`);
  }
  return canonicalRoot;
};
