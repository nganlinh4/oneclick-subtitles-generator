import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { comparableWindowsPath, decodeMediaLocationPath } from './mediaLocationOracle.js';

const windowsRow = (path) => ({
  path_bytes: Buffer.from(path, 'utf16le'),
  path_encoding: 'windows-utf16le',
});

test('decodes a windows-utf16le extended-length pointer to the selected file', () => {
  const decoded = decodeMediaLocationPath(windowsRow('\\\\?\\C:\\run\\input\\Me at the zoo.mp4'));
  assert.equal(decoded, '\\\\?\\C:\\run\\input\\Me at the zoo.mp4');
  assert.equal(
    comparableWindowsPath(decoded),
    comparableWindowsPath('C:/run/INPUT/Me At The Zoo.MP4'),
  );
});

test('decodes unix bytes and refuses unknown encodings', () => {
  assert.equal(
    decodeMediaLocationPath({ path_bytes: Buffer.from('/home/user/a.mp4'), path_encoding: 'unix-bytes' }),
    '/home/user/a.mp4',
  );
  assert.throws(
    () => decodeMediaLocationPath({ path_bytes: Buffer.from('x'), path_encoding: 'utf8' }),
    /unknown media location encoding/u,
  );
});

test('refuses missing, empty, oversized and odd-length pointers', () => {
  assert.throws(() => decodeMediaLocationPath({ path_bytes: null, path_encoding: 'unix-bytes' }),
    /missing/u);
  assert.throws(
    () => decodeMediaLocationPath({ path_bytes: Buffer.alloc(0), path_encoding: 'unix-bytes' }),
    /invalid length/u,
  );
  assert.throws(
    () => decodeMediaLocationPath({
      path_bytes: Buffer.alloc(64 * 1024 + 2), path_encoding: 'windows-utf16le',
    }),
    /invalid length/u,
  );
  assert.throws(
    () => decodeMediaLocationPath({ path_bytes: Buffer.alloc(3), path_encoding: 'windows-utf16le' }),
    /even byte count/u,
  );
});

test('comparable form differs for genuinely different files', () => {
  assert.notEqual(
    comparableWindowsPath('C:\\run\\input\\a.mp4'),
    comparableWindowsPath('C:\\run\\input\\b.mp4'),
  );
  assert.throws(() => comparableWindowsPath('   '), /not comparable/u);
});
