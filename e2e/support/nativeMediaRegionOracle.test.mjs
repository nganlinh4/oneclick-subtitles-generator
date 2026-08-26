import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { digestRgbaRegion } from './nativeMediaOracle.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const stridedFrame = ({ width = 4, height = 3, stride = 20 } = {}) => {
  const bytes = Buffer.alloc(stride * height, 0xee);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * stride) + (x * 4);
      bytes.set([x, y, (y * width) + x, 0xff], offset);
    }
  }
  return bytes;
};

test('hashes only the requested RGBA pixels across padded source rows', () => {
  const bytes = stridedFrame();
  const expectedPixels = Buffer.from([
    1, 1, 5, 0xff,
    2, 1, 6, 0xff,
    1, 2, 9, 0xff,
    2, 2, 10, 0xff,
  ]);
  const digest = digestRgbaRegion(bytes, {
    frameWidth: 4,
    frameHeight: 3,
    rowStrideBytes: 20,
    x: 1,
    y: 1,
    width: 2,
    height: 2,
  });

  assert.deepEqual(digest, {
    frameWidth: 4,
    frameHeight: 3,
    rowStrideBytes: 20,
    x: 1,
    y: 1,
    width: 2,
    height: 2,
    pixels: 4,
    bytes: 16,
    sha256: sha256(expectedPixels),
  });
  assert.ok(Object.isFrozen(digest));
});

test('ignores row padding and pixels outside the region but notices every selected byte', () => {
  const baseline = stridedFrame();
  const options = {
    frameWidth: 4,
    frameHeight: 3,
    rowStrideBytes: 20,
    x: 1,
    y: 1,
    width: 2,
    height: 2,
  };
  const digest = digestRgbaRegion(baseline, options).sha256;

  const paddingChanged = Buffer.from(baseline);
  paddingChanged[19] ^= 0xff;
  paddingChanged[39] ^= 0xff;
  assert.equal(digestRgbaRegion(paddingChanged, options).sha256, digest);

  const outsideChanged = Buffer.from(baseline);
  outsideChanged[0] ^= 0xff;
  assert.equal(digestRgbaRegion(outsideChanged, options).sha256, digest);

  const insideChanged = Buffer.from(baseline);
  insideChanged[(2 * 20) + (2 * 4) + 3] ^= 0xff;
  assert.notEqual(digestRgbaRegion(insideChanged, options).sha256, digest);
});

test('accepts exact bottom-right crop boundaries and a byte-offset view', () => {
  const storage = Buffer.alloc(4 + (2 * 2 * 4) + 7, 0xa5);
  const pixels = storage.subarray(4, 20);
  pixels.set([
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16,
  ]);

  const result = digestRgbaRegion(pixels, {
    frameWidth: 2,
    frameHeight: 2,
    x: 1,
    y: 1,
    width: 1,
    height: 1,
  });
  assert.equal(result.sha256, sha256(Buffer.from([13, 14, 15, 16])));
});

test('refuses invalid or out-of-frame crop bounds before hashing', () => {
  const pixels = new Uint8Array(2 * 2 * 4);
  const options = { frameWidth: 2, frameHeight: 2, x: 0, y: 0, width: 1, height: 1 };

  for (const invalid of [
    { x: -1 },
    { y: -1 },
    { x: 0.5 },
    { width: 0 },
    { height: Number.NaN },
  ]) {
    assert.throws(
      () => digestRgbaRegion(pixels, { ...options, ...invalid }),
      /region geometry is invalid/u,
    );
  }
  assert.throws(
    () => digestRgbaRegion(pixels, { ...options, x: 2 }),
    /region exceeds/u,
  );
  assert.throws(
    () => digestRgbaRegion(pixels, { ...options, y: 1, height: 2 }),
    /region exceeds/u,
  );
});

test('refuses malformed frame geometry, stride, byte length, and input type', () => {
  const pixels = new Uint8Array(2 * 2 * 4);
  const options = { frameWidth: 2, frameHeight: 2, x: 0, y: 0, width: 1, height: 1 };

  assert.throws(
    () => digestRgbaRegion(pixels, { ...options, frameWidth: 0 }),
    /comparison geometry is invalid/u,
  );
  assert.throws(
    () => digestRgbaRegion(pixels, { ...options, frameHeight: 2.5 }),
    /comparison geometry is invalid/u,
  );
  assert.throws(
    () => digestRgbaRegion(pixels, {
      ...options, frameWidth: 16_385, frameHeight: 16_385,
    }),
    /comparison exceeds/u,
  );
  assert.throws(
    () => digestRgbaRegion(pixels, { ...options, rowStrideBytes: 7 }),
    /row stride is invalid/u,
  );
  assert.throws(
    () => digestRgbaRegion(pixels, { ...options, rowStrideBytes: 8.5 }),
    /row stride is invalid/u,
  );
  assert.throws(
    () => digestRgbaRegion(pixels, { ...options, rowStrideBytes: Number.MAX_SAFE_INTEGER }),
    /strided buffer is too large/u,
  );
  assert.throws(
    () => digestRgbaRegion(pixels.subarray(1), options),
    /strided byte length does not match/u,
  );
  assert.throws(
    () => digestRgbaRegion('not bytes', options),
    /input must be a byte array/u,
  );
});
