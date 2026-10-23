'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { REPOSITORY_ROOT, invariant, toRepositoryPath, walkFiles } = require('./shared');

/**
 * The deleted browser render path stays deleted. This is the rule that keeps it that way.
 *
 * It is deliberately a token scan rather than a dependency or import check: that payload reached a
 * build through a package name, a delivery-catalog path, a bundle resource, an `include_str!` and a
 * worker filename, and every one of those is plain text before it is anything else. A dependency
 * graph would have caught the first and missed the rest.
 *
 * The token is assembled from halves so this gate is not its own first offender; an exemption for
 * `scripts/` is where the next reintroduction would land unnoticed.
 *
 * Only the build roots are scanned; documentation outside them may still describe the old path.
 */
const LEGACY_RENDERER_ROOTS = ['src', 'crates', 'apps', 'scripts'];
const LEGACY_RENDERER_MANIFESTS = ['package.json', 'package-lock.json'];
/** Dependency and build caches: not sources, and not something a reviewer can edit. */
const LEGACY_RENDERER_SKIPPED_DIRECTORIES = new Set(['node_modules', 'target', '__pycache__']);
const LEGACY_RENDERER_BINARY = new RegExp(
  '\\.(?:png|jpe?g|gif|webp|avif|ico|icns|mp4|mkv|webm|mp3|wav|m4a|ogg|flac|woff2?|ttf|otf'
  + '|zip|7z|gz|tar|exe|dll|pdb|so|dylib|bin|onnx|safetensors|pt|pth|pyc|pyo|gguf)$',
  'i',
);
const LEGACY_RENDERER_TOKEN = new RegExp(['re', 'motion'].join(''), 'i');

function assertNoLegacyRendererResidue(rootDirectory = REPOSITORY_ROOT) {
  const candidates = [
    ...LEGACY_RENDERER_MANIFESTS
      .map((relativePath) => path.join(rootDirectory, relativePath))
      .filter((candidate) => fs.existsSync(candidate)),
    ...LEGACY_RENDERER_ROOTS.flatMap((relativeRoot) => walkFiles(
      path.join(rootDirectory, relativeRoot),
      (candidate) => !LEGACY_RENDERER_BINARY.test(candidate),
      LEGACY_RENDERER_SKIPPED_DIRECTORIES,
    )),
  ];
  const offenders = [];
  for (const candidate of candidates) {
    if (LEGACY_RENDERER_TOKEN.test(fs.readFileSync(candidate, 'utf8'))) {
      offenders.push(toRepositoryPath(rootDirectory, candidate));
    }
  }
  const displayed = offenders.slice(0, 12);
  const omitted = offenders.length - displayed.length;
  invariant(
    offenders.length === 0,
    `The deleted browser render path is reachable again from ${offenders.length} file(s): ${
      displayed.join(', ')}${omitted > 0 ? `, and ${omitted} more` : ''
    }; the native export owns rendering, so remove the reference rather than re-adding the payload`,
  );
}

module.exports = { assertNoLegacyRendererResidue };
