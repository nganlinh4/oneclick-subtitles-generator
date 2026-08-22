#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The exact stylesheet the product build must produce.
 *
 * REPINNED because the build began minifying CSS again, not because the design changed. `esbuild`
 * had become undeclared and unresolvable, so `cssMinify: 'esbuild'` silently produced an unminified
 * stylesheet; the previous pin (682_209 bytes, one rule per line) recorded that state. With the
 * dependency declared again the same sources emitted 587_843 minified bytes. The current reviewed
 * pin restores the original copy-free first-run controls, fixes their row alignment, and removes
 * the redundant empty-project sentence from the video surface. Real-binary screenshots cover both
 * surfaces: the three original controls stay on one row and a cue-less video remains unobstructed.
 *
 * The design was verified unchanged rather than assumed: all 151 Material custom properties, and
 * the album-art, floating-scrollbar and liquid-glass surface counts, are identical. Two counters
 * moved, and both are artefacts of how a minifier rewrites text rather than of what it renders —
 * `.custom-slider` fell 45 -> 44 and unresolved Material names 47 -> 32 as duplicate selectors and
 * repeated declarations were merged away. A counter that reads minified output measures the file,
 * not the appearance, which is why the source-level freeze (`npm run check:visual-freeze`) is the
 * authority on the design and this file is the authority on the artefact.
 */
export const FROZEN_CSS_ARTIFACT = Object.freeze({
  fileName: 'index-1UfjNcyC.css',
  sha256: 'b9cc1f676e2c63485691fdbb8c2b06d8a7a8724744a25694c544bbcf58887c4b',
  sizeBytes: 588_298,
  parity: Object.freeze({
    albumArtCount: 22,
    customSliderCount: 44,
    floatingScrollbarCount: 19,
    fontFaceCount: 0,
    googleSansFlexCount: 0,
    liquidGlassCount: 50,
    materialDefinitionCount: 151,
    materialUnresolvedCount: 32,
  }),
});

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

export function assertFrozenCssBuildOutput(rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  return verifyFrozenCssArtifact(resolve(rootDirectory, 'build/assets'));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = assertFrozenCssBuildOutput();
    console.log(
      `Frozen CSS output passed: ${result.fileName}, ${result.sizeBytes} bytes, SHA-256 ${result.sha256}.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
