import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);

export const PINNED_REMOTION_VERSION = '4.0.507';
const REMOTION_MAIN_ESM_ENTRY = 'dist/esm/index.mjs';
const REMOTION_NO_REACT_ESM_ENTRY = 'dist/esm/no-react.mjs';
export const PINNED_REMOTION_ESM_SHA256 = Object.freeze({
  [REMOTION_MAIN_ESM_ENTRY]:
    '5dfe15118079ebdc11aae1a20717656191ee496ad678fb852077151feb467adf',
  [REMOTION_NO_REACT_ESM_ENTRY]:
    'b82e0ecc821b7a9385c0c25328fe25fc7d68d54ee654ea3f908a4c319eec8210',
});
const VIDEO_FRAGMENT_FALLBACK =
  'const existingHash = Boolean(new URL(actualSrc, (typeof window === "undefined" ? null : window.location.href) ?? "http://localhost:3000").hash);';
const DESKTOP_VIDEO_FRAGMENT_FALLBACK =
  'const existingHash = Boolean(new URL(actualSrc, (typeof window === "undefined" ? null : window.location.href) ?? "file:///").hash);';
const OFFTHREAD_PROXY_RETURN =
  '  return `http://localhost:${window.remotion_proxyPort}/proxy?src=${encodeURIComponent(getAbsoluteSrc(src))}&time=${encodeURIComponent(Math.max(0, currentTime))}&transparent=${String(transparent)}&toneMapped=${String(toneMapped)}`;';
const DESKTOP_OFFTHREAD_PROXY_RETURN =
  '  throw new Error("Remotion OffthreadVideo proxy transport is unavailable in the desktop preview");';

const sha256 = (source) => createHash('sha256').update(source).digest('hex');

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const countOccurrences = (source, needle) => source.split(needle).length - 1;

const replaceExactlyOnce = (source, needle, replacement, label) => {
  const count = countOccurrences(source, needle);
  invariant(count === 1, `Pinned Remotion ${label} pattern must occur exactly once; found ${count}`);
  return source.replace(needle, replacement);
};

const normalizeModuleId = (id) => {
  const withoutQuery = id.split('?')[0];
  const absolute = resolve(withoutQuery).replaceAll('\\', '/');
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};

export function rewriteExactRemotionTransportPatterns(source, entrypoint) {
  let rewritten = source;
  if (entrypoint === REMOTION_MAIN_ESM_ENTRY) {
    rewritten = replaceExactlyOnce(
      rewritten,
      VIDEO_FRAGMENT_FALLBACK,
      DESKTOP_VIDEO_FRAGMENT_FALLBACK,
      'video-fragment fallback',
    );
  } else {
    invariant(
      entrypoint === REMOTION_NO_REACT_ESM_ENTRY,
      `Unsupported Remotion ESM entrypoint ${entrypoint}`,
    );
  }
  rewritten = replaceExactlyOnce(
    rewritten,
    OFFTHREAD_PROXY_RETURN,
    DESKTOP_OFFTHREAD_PROXY_RETURN,
    'OffthreadVideo proxy',
  );

  invariant(
    !rewritten.includes('http://localhost:3000') &&
      !rewritten.includes('window.remotion_proxyPort'),
    'Pinned Remotion transport rewrite left a forbidden localhost transport behind',
  );
  return rewritten;
}

export function rewritePinnedRemotionEsm(source, version, entrypoint) {
  invariant(
    version === PINNED_REMOTION_VERSION,
    `Unsupported Remotion version ${version}; expected ${PINNED_REMOTION_VERSION}`,
  );
  const actualHash = sha256(source);
  const expectedHash = PINNED_REMOTION_ESM_SHA256[entrypoint];
  invariant(expectedHash, `Unsupported Remotion ESM entrypoint ${entrypoint}`);
  invariant(
    actualHash === expectedHash,
    `Remotion ${version} ${entrypoint} source integrity mismatch: expected ${expectedHash}, got ${actualHash}`,
  );
  return rewriteExactRemotionTransportPatterns(source, entrypoint);
}

export function resolvePinnedRemotionInstallation(
  packageJsonPath = require.resolve('remotion/package.json'),
  read = readFileSync,
) {
  const packageJson = JSON.parse(read(packageJsonPath, 'utf8'));
  invariant(packageJson.name === 'remotion', 'Resolved package is not Remotion');
  invariant(
    packageJson.version === PINNED_REMOTION_VERSION,
    `Unsupported Remotion version ${packageJson.version}; expected ${PINNED_REMOTION_VERSION}`,
  );
  invariant(
    packageJson.module === REMOTION_MAIN_ESM_ENTRY &&
      packageJson.exports?.['.']?.module === `./${REMOTION_MAIN_ESM_ENTRY}` &&
      packageJson.exports?.['.']?.import === `./${REMOTION_MAIN_ESM_ENTRY}` &&
      packageJson.exports?.['./no-react']?.module === `./${REMOTION_NO_REACT_ESM_ENTRY}` &&
      packageJson.exports?.['./no-react']?.import === `./${REMOTION_NO_REACT_ESM_ENTRY}`,
    `Remotion ${PINNED_REMOTION_VERSION} ESM entrypoint contract changed`,
  );

  const modules = [REMOTION_MAIN_ESM_ENTRY, REMOTION_NO_REACT_ESM_ENTRY].map((entrypoint) => {
    const modulePath = resolve(dirname(packageJsonPath), entrypoint);
    const source = read(modulePath, 'utf8');
    rewritePinnedRemotionEsm(source, packageJson.version, entrypoint);
    return Object.freeze({ entrypoint, modulePath, source });
  });
  return Object.freeze({ modules: Object.freeze(modules), version: packageJson.version });
}

export function createRemotionDesktopBoundaryPlugin(options = {}) {
  let installation = null;
  let moduleById = null;
  let transformedModuleIds = null;

  return {
    name: 'osg-remotion-desktop-boundary',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      installation = resolvePinnedRemotionInstallation(
        options.packageJsonPath,
        options.readFileSync,
      );
      moduleById = new Map(
        installation.modules.map((module) => [normalizeModuleId(module.modulePath), module]),
      );
      transformedModuleIds = new Set();
    },
    transform(source, id) {
      invariant(installation, 'Remotion desktop boundary was not initialized before transform');
      const normalizedId = normalizeModuleId(id);
      const module = moduleById.get(normalizedId);
      if (!module) return null;

      invariant(
        !transformedModuleIds.has(normalizedId),
        `Pinned Remotion ESM module ${module.entrypoint} was transformed more than once`,
      );
      transformedModuleIds.add(normalizedId);
      return {
        code: rewritePinnedRemotionEsm(source, installation.version, module.entrypoint),
        map: null,
      };
    },
    generateBundle() {
      const missing = installation.modules
        .filter((module) => !transformedModuleIds.has(normalizeModuleId(module.modulePath)))
        .map((module) => module.entrypoint);
      invariant(
        missing.length === 0,
        `Pinned Remotion ESM modules must each be transformed exactly once; missing ${missing.join(', ')}`,
      );
    },
  };
}
