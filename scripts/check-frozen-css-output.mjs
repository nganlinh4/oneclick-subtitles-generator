#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FROZEN_CSS_ARTIFACT = Object.freeze({
  fileName: 'index-CwMXmTlz.css',
  sha256: '207f68d9887276d6df98ce51021ede5689b816e21b4d8e1e87878f811387d0d0',
  sizeBytes: 682_209,
  parity: Object.freeze({
    albumArtCount: 22,
    customSliderCount: 45,
    floatingScrollbarCount: 19,
    fontFaceCount: 0,
    googleSansFlexCount: 0,
    liquidGlassCount: 50,
    materialDefinitionCount: 151,
    materialUnresolvedCount: 47,
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
