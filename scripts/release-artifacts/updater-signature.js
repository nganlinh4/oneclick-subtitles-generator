'use strict';

// Verify a release installer's minisign-compatible updater signature against the committed key.

const fs = require('node:fs');
const path = require('node:path');
const { createHash, createPublicKey, verify } = require('node:crypto');
const { TextDecoder } = require('node:util');

const { REPOSITORY_ROOT } = require('../release-readiness/shared');
const { invariant } = require('./bundles');

function decodeCanonicalBase64(value, label) {
  invariant(typeof value === 'string' && value.length > 0, `${label} is empty`);
  invariant(
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0,
    `${label} is not canonical base64`,
  );
  const decoded = Buffer.from(value, 'base64');
  invariant(decoded.toString('base64') === value, `${label} is not canonical base64`);
  return decoded;
}

function decodeUtf8Envelope(encoded, label) {
  const bytes = decodeCanonicalBase64(encoded.trim(), label);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not UTF-8`);
  }
}

function envelopeLines(value, expectedCount, label) {
  const normalized = value.endsWith('\n') ? value.slice(0, -1) : value;
  invariant(!normalized.includes('\r'), `${label} must use canonical LF line endings`);
  const lines = normalized.split('\n');
  invariant(lines.length === expectedCount, `${label} has an invalid line count`);
  return lines;
}

function verifyUpdaterSignature(artifact, signaturePath, encodedPublicKey) {
  const publicEnvelope = decodeUtf8Envelope(encodedPublicKey, 'Updater public key');
  const publicLines = envelopeLines(publicEnvelope, 2, 'Updater public key');
  invariant(
    publicLines[0].startsWith('untrusted comment:'),
    'Updater public key has no Minisign comment',
  );
  const publicBytes = decodeCanonicalBase64(publicLines[1], 'Updater public key payload');
  invariant(publicBytes.length === 42, 'Updater public key payload has an invalid length');
  invariant(
    (publicBytes[0] === 0x45 && publicBytes[1] === 0x64)
      || (publicBytes[0] === 0x45 && publicBytes[1] === 0x44),
    'Updater public key uses an unsupported algorithm',
  );

  invariant(fs.existsSync(signaturePath), `Updater signature is missing: ${signaturePath}`);
  const signatureOuter = fs.readFileSync(signaturePath, 'utf8').trim();
  const signatureEnvelope = decodeUtf8Envelope(signatureOuter, 'Updater signature');
  const signatureLines = envelopeLines(signatureEnvelope, 4, 'Updater signature');
  invariant(
    signatureLines[0].startsWith('untrusted comment:'),
    'Updater signature has no Minisign comment',
  );
  invariant(
    signatureLines[2].startsWith('trusted comment: '),
    'Updater signature has no trusted comment',
  );
  const signatureBytes = decodeCanonicalBase64(signatureLines[1], 'Updater signature payload');
  const globalSignature = decodeCanonicalBase64(signatureLines[3], 'Updater global signature');
  invariant(signatureBytes.length === 74, 'Updater signature payload has an invalid length');
  invariant(globalSignature.length === 64, 'Updater global signature has an invalid length');
  invariant(
    signatureBytes[0] === 0x45 && signatureBytes[1] === 0x44,
    'Updater signature must use prehashed Minisign mode',
  );
  invariant(
    publicBytes.subarray(2, 10).equals(signatureBytes.subarray(2, 10)),
    'Updater signature key ID does not match the configured public key',
  );

  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    publicBytes.subarray(10),
  ]);
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const artifactDigest = createHash('blake2b512').update(fs.readFileSync(artifact)).digest();
  invariant(
    verify(null, artifactDigest, key, signatureBytes.subarray(10)),
    `Updater signature does not authenticate ${path.basename(artifact)}`,
  );
  const trustedComment = Buffer.from(signatureLines[2].slice('trusted comment: '.length), 'utf8');
  invariant(
    verify(
      null,
      Buffer.concat([signatureBytes.subarray(10), trustedComment]),
      key,
      globalSignature,
    ),
    'Updater trusted comment signature is invalid',
  );
}

function assertUpdaterSignature(artifact, rootDirectory = REPOSITORY_ROOT) {
  const config = JSON.parse(
    fs.readFileSync(path.join(rootDirectory, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
  );
  invariant(
    config.bundle?.createUpdaterArtifacts === true,
    'Tauri must create updater artifacts for release installers',
  );
  const encodedPublicKey = config.plugins?.updater?.pubkey;
  invariant(typeof encodedPublicKey === 'string', 'Tauri updater public key is missing');
  verifyUpdaterSignature(artifact, `${artifact}.sig`, encodedPublicKey);
}

function assertUpdaterSignatureMode(
  artifact,
  { allowUnsigned = false, rootDirectory = REPOSITORY_ROOT } = {},
) {
  if (!allowUnsigned) {
    assertUpdaterSignature(artifact, rootDirectory);
    return;
  }
  invariant(
    !fs.existsSync(`${artifact}.sig`),
    'Unsigned branch validation must not accept or ignore a signature sidecar',
  );
}

module.exports = {
  assertUpdaterSignature,
  assertUpdaterSignatureMode,
  verifyUpdaterSignature,
};
