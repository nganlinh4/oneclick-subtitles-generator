'use strict';

// Field validators shared by every content-addressed delivery catalog, plus the check that a
// managed-runtime command is wired through build.rs, the handler list, and the ACL.

const path = require('node:path');

const { escapeRegularExpression, invariant, readText } = require('./shared');

function assertImmutableSourceUrl(rawUrl, componentId) {
  let sourceUrl;
  try {
    sourceUrl = new URL(rawUrl);
  } catch {
    throw new Error(`Runtime manifest ${componentId} sourceUrl is invalid`);
  }
  invariant(sourceUrl.protocol === 'https:', `Runtime manifest ${componentId} sourceUrl must use HTTPS`);
  invariant(!sourceUrl.username && !sourceUrl.password, `Runtime manifest ${componentId} sourceUrl may not contain credentials`);
  invariant(!sourceUrl.hash && !sourceUrl.search, `Runtime manifest ${componentId} sourceUrl must be immutable and query-free`);
  invariant(!/(?:^|\/)latest(?:\/|$)/i.test(sourceUrl.pathname), `Runtime manifest ${componentId} sourceUrl may not use a latest alias`);
}


function assertPositiveInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
}

function assertSha256(value, label) {
  invariant(/^[0-9a-f]{64}$/.test(value), `${label} must be a lowercase SHA-256 digest`);
}

function assertSafeManifestPath(value, label) {
  invariant(typeof value === 'string' && value.length > 0, `${label} must be a non-empty path`);
  const normalized = value.replaceAll('\\', '/');
  invariant(
    !path.posix.isAbsolute(normalized) &&
      normalized.split('/').every((component) => component && component !== '.' && component !== '..'),
    `${label} must be a safe relative path`,
  );
  return normalized;
}

function assertCommandWiring(rootDirectory, command) {
  invariant(/^[a-z][a-z0-9_]{2,63}$/.test(command), `Managed-runtime command is invalid: ${command}`);
  for (const relativePath of [
    'apps/desktop/src-tauri/build.rs',
    'apps/desktop/src-tauri/src/lib.rs',
    'apps/desktop/src-tauri/permissions/app.toml',
  ]) {
    const source = readText(rootDirectory, relativePath);
    invariant(
      new RegExp(`\\b${escapeRegularExpression(command)}\\b`).test(source),
      `${relativePath} does not wire managed-runtime command ${command}`,
    );
  }
}

module.exports = {
  assertCommandWiring,
  assertImmutableSourceUrl,
  assertPositiveInteger,
  assertSafeManifestPath,
  assertSha256,
};
