import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectFrozenCssParity, verifyFrozenCssArtifact } from './check-frozen-css-output.mjs';

function createFixture(context, contents = 'frozen css') {
  const root = mkdtempSync(join(tmpdir(), 'osg-frozen-css-output-'));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const assets = join(root, 'build', 'assets');
  mkdirSync(assets, { recursive: true });
  const expected = {
    fileName: 'index-test.css',
    sha256: createHash('sha256').update(contents).digest('hex'),
    sizeBytes: Buffer.byteLength(contents),
  };
  writeFileSync(join(assets, expected.fileName), contents);
  return { assets, expected };
}

test('accepts one byte-identical CSS artifact', (context) => {
  const { assets, expected } = createFixture(context);
  assert.deepEqual(verifyFrozenCssArtifact(assets, expected), expected);
});

test('rejects a missing or ambiguous main CSS artifact', (context) => {
  const { assets, expected } = createFixture(context);
  const missing = join(assets, 'missing');
  assert.throws(() => verifyFrozenCssArtifact(missing, expected), /asset directory is missing/);
  writeFileSync(join(assets, 'index-other.css'), 'other css');
  assert.throws(
    () => verifyFrozenCssArtifact(assets, expected),
    /expected exactly one index-\*\.css artifact; found 2/,
  );
});

test('rejects artifact name, byte-size, and digest drift', (context) => {
  const nameFixture = createFixture(context);
  assert.throws(
    () => verifyFrozenCssArtifact(nameFixture.assets, {
      ...nameFixture.expected,
      fileName: 'index-expected.css',
    }),
    /artifact name drifted/,
  );

  const sizeFixture = createFixture(context);
  assert.throws(
    () => verifyFrozenCssArtifact(sizeFixture.assets, {
      ...sizeFixture.expected,
      sizeBytes: sizeFixture.expected.sizeBytes + 1,
    }),
    /byte size drifted/,
  );

  const hashFixture = createFixture(context);
  assert.throws(
    () => verifyFrozenCssArtifact(hashFixture.assets, {
      ...hashFixture.expected,
      sha256: '0'.repeat(64),
    }),
    /SHA-256 drifted/,
  );
});

test('rejects a byte-valid artifact when pre-port CSS surfaces are missing', (context) => {
  const fixture = createFixture(context, '.custom-slider{}');
  assert.deepEqual(inspectFrozenCssParity('.custom-slider{}'), {
    albumArtCount: 0,
    customSliderCount: 1,
    floatingScrollbarCount: 0,
    fontFaceCount: 0,
    googleSansFlexCount: 0,
    liquidGlassCount: 0,
    materialDefinitionCount: 0,
    materialUnresolvedCount: 0,
    productSansCount: 0,
  });
  assert.throws(
    () => verifyFrozenCssArtifact(fixture.assets, {
      ...fixture.expected,
      parity: { fontFaceCount: 5 },
    }),
    /pre-port CSS surface fontFaceCount drifted; expected 5, found 0/,
  );
});
