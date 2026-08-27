#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The exact base and narration stylesheets the product build must produce.
 *
 * REPINNED because the build began minifying CSS again, not because the design changed. `esbuild`
 * had become undeclared and unresolvable, so `cssMinify: 'esbuild'` silently produced an unminified
 * stylesheet; the previous pin (682_209 bytes, one rule per line) recorded that state. With the
 * dependency declared again the same sources emitted 587_843 minified bytes. The current reviewed
 * pin restores the original copy-free first-run controls, fixes their row alignment, and removes
 * the redundant empty-project sentence from the video surface. The current pin also moves preview
 * failures out of the picture into the toast channel and restores the native render player's
 * play/seek/mute/fullscreen controls. Real-binary screenshots cover both preview surfaces.
 *
 * The design was verified unchanged rather than assumed: all 151 Material custom properties, and
 * the album-art, floating-scrollbar and liquid-glass surface counts, are identical. Narration is a
 * required initial JavaScript boundary now, so Vite emits its CSS separately instead of letting the
 * minifier merge it into index.css. The combined `.custom-slider` textual count is therefore 54
 * rather than 44: duplicate selectors across two files cannot be merged. This contract pins both
 * files byte-for-byte and evaluates the semantic inventory across their combined contents.
 *
 * REPINNED after the native-waveform module-graph rewrite: the reviewed production build adds 243
 * minified bytes to the base artifact. A detached build of its parent revision emits the same file,
 * and every semantic inventory count below remains unchanged, so this records build reality rather
 * than approving a design change.
 *
 * REPINNED after the atomic-preview change removed the obsolete `.rendering-overlay`,
 * `.rendering-progress`, and `.rendering-text` rules. Render progress now belongs to the toast
 * channel and those selectors have no shipping consumer. Two clean production builds emitted the
 * same bytes, while every semantic inventory count below remained unchanged.
 *
 * REPINNED after the native-ownership alignment made the settings modal a static import: its
 * previously separate `SettingsModal-*.css` chunk (91,798 bytes, which the older prefix-based
 * candidate scan never inspected) now merges into the base artifact, and the same commit pruned
 * the legacy transport rules from six stylesheets. Verified rather than assumed: a detached
 * build of the previous pin's own revision reproduces the old base artifact byte-for-byte, and
 * the combined semantic inventory of ALL THREE old files equals the combined inventory of the
 * two current files on every surface below. The two count changes therefore record the settings
 * chunk becoming visible to this contract, not new styling: its `.custom-slider` selector and
 * its twelve runtime-themed `--md-*` uses were always shipped. The narration artifact is
 * byte-identical across the change.
 */
export const FROZEN_CSS_ARTIFACTS = Object.freeze({
  files: Object.freeze([
    Object.freeze({
      fileName: 'index-Bebnduw6.css',
      sha256: '23c7acd3ba083ff2be5f2f94f75fe8ead13124c99ad55fd47fb6067440995751',
      sizeBytes: 579_620,
    }),
    Object.freeze({
      fileName: 'narration-OoOluj4s.css',
      sha256: '64cb0e2c198896e0d373f787130e629ed60a93434065ef06176503e976d48b46',
      sizeBytes: 109_116,
    }),
  ]),
  parity: Object.freeze({
    albumArtCount: 22,
    customSliderCount: 55,
    floatingScrollbarCount: 19,
    fontFaceCount: 0,
    googleSansFlexCount: 0,
    liquidGlassCount: 50,
    materialDefinitionCount: 151,
    materialUnresolvedCount: 44,
  }),
});
export const FROZEN_CSS_ARTIFACT = FROZEN_CSS_ARTIFACTS.files[0];

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`Frozen CSS output check failed: ${message}`);
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

const countMatches = (source, pattern) => [...source.matchAll(pattern)].length;

export function inspectFrozenCssParity(contents) {
  const source = Buffer.isBuffer(contents) ? contents.toString('utf8') : contents;
  const materialDefinitions = new Set(
    [...source.matchAll(/--md-[A-Za-z0-9-]+\s*:/g)].map((match) => match[0].split(':', 1)[0]),
  );
  const materialUses = [...source.matchAll(/var\((--md-[A-Za-z0-9-]+)/g)]
    .map((match) => match[1]);
  const materialUnresolved = new Set(
    materialUses.filter((name) => !materialDefinitions.has(name)),
  );
  return Object.freeze({
    albumArtCount: countMatches(source, /album-art/g),
    customSliderCount: countMatches(source, /\.custom-slider/g),
    floatingScrollbarCount: countMatches(source, /\.floating-scrollbar/g),
    fontFaceCount: countMatches(source, /@font-face/g),
    googleSansFlexCount: countMatches(source, /GoogleSansFlex/g),
    liquidGlassCount: countMatches(source, /\.liquid-glass/g),
    materialDefinitionCount: materialDefinitions.size,
    materialUnresolvedCount: materialUnresolved.size,
  });
}

function assertFrozenCssParity(contents, expected) {
  const actual = inspectFrozenCssParity(contents);
  for (const [surface, count] of Object.entries(expected)) {
    invariant(
      actual[surface] === count,
      `pre-port CSS surface ${surface} drifted; expected ${count}, found ${actual[surface]}`,
    );
  }
}

export function verifyFrozenCssArtifact(assetsDirectory, expected = FROZEN_CSS_ARTIFACT) {
  invariant(existsSync(assetsDirectory), `asset directory is missing: ${assetsDirectory}`);
  const directoryMetadata = lstatSync(assetsDirectory);
  invariant(
    directoryMetadata.isDirectory() && !directoryMetadata.isSymbolicLink(),
    `asset path must be a real directory: ${assetsDirectory}`,
  );

  const candidates = readdirSync(assetsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^index-[A-Za-z0-9_-]+\.css$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  invariant(
    candidates.length === 1,
    `expected exactly one index-*.css artifact; found ${candidates.length}${candidates.length > 0 ? ` (${candidates.join(', ')})` : ''}`,
  );

  const [fileName] = candidates;
  const artifactPath = resolve(assetsDirectory, fileName);
  const metadata = lstatSync(artifactPath);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${fileName} must be a real file`);
  const digest = sha256File(artifactPath);
  invariant(
    fileName === expected.fileName,
    `artifact name drifted; expected ${expected.fileName}, found ${fileName} (${metadata.size} bytes, SHA-256 ${digest})`,
  );
  invariant(
    metadata.size === expected.sizeBytes,
    `${fileName} byte size drifted; expected ${expected.sizeBytes}, found ${metadata.size}`,
  );
  invariant(
    digest === expected.sha256,
    `${fileName} SHA-256 drifted; expected ${expected.sha256}, found ${digest}`,
  );
  if (expected.parity) assertFrozenCssParity(readFileSync(artifactPath), expected.parity);
  return Object.freeze({ fileName, sha256: digest, sizeBytes: metadata.size });
}

export function verifyFrozenCssArtifacts(assetsDirectory, expected = FROZEN_CSS_ARTIFACTS) {
  invariant(existsSync(assetsDirectory), `asset directory is missing: ${assetsDirectory}`);
  const directoryMetadata = lstatSync(assetsDirectory);
  invariant(
    directoryMetadata.isDirectory() && !directoryMetadata.isSymbolicLink(),
    `asset path must be a real directory: ${assetsDirectory}`,
  );
  invariant(Array.isArray(expected.files) && expected.files.length > 0,
    'at least one frozen CSS artifact is required');

  // Every emitted stylesheet is in scope. The previous prefix-derived scan had two blind spots:
  // a Vite content hash containing a dash truncated the prefix past the hash (so a renamed base
  // artifact read as "missing" instead of "drifted"), and a code-split chunk under a novel name
  // was never inspected at all — a settings-modal chunk shipped unpinned for weeks that way.
  const candidates = readdirSync(assetsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
    .map((entry) => entry.name)
    .sort();
  const expectedNames = expected.files.map(({ fileName }) => fileName).sort();
  invariant(
    JSON.stringify(candidates) === JSON.stringify(expectedNames),
    `frozen CSS artifact set drifted; expected ${expectedNames.join(', ')}, found ${candidates.join(', ')}`,
  );

  const contents = [];
  const files = expected.files.map((file) => {
    const artifactPath = resolve(assetsDirectory, file.fileName);
    const metadata = lstatSync(artifactPath);
    invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${file.fileName} must be a real file`);
    const bytes = readFileSync(artifactPath);
    const digest = createHash('sha256').update(bytes).digest('hex');
    invariant(metadata.size === file.sizeBytes,
      `${file.fileName} byte size drifted; expected ${file.sizeBytes}, found ${metadata.size}`);
    invariant(digest === file.sha256,
      `${file.fileName} SHA-256 drifted; expected ${file.sha256}, found ${digest}`);
    contents.push(bytes);
    return Object.freeze({ fileName: file.fileName, sha256: digest, sizeBytes: metadata.size });
  });
  if (expected.parity) assertFrozenCssParity(Buffer.concat(contents), expected.parity);
  return Object.freeze({ files: Object.freeze(files) });
}

export function assertFrozenCssBuildOutput(rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  return verifyFrozenCssArtifacts(resolve(rootDirectory, 'build/assets'));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = assertFrozenCssBuildOutput();
    console.log(
      `Frozen CSS output passed: ${result.files.map((file) => (
        `${file.fileName} (${file.sizeBytes} bytes, SHA-256 ${file.sha256})`
      )).join('; ')}.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
