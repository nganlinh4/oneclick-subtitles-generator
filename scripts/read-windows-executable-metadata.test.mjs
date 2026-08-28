import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readWindowsExecutableVersionInfo,
  windowsVersionMatchesSemver,
} from './read-windows-executable-metadata.mjs';

const fakeSpawnReturning = (payload, status = 0) => () => ({
  error: null,
  status,
  stdout: JSON.stringify(payload),
  stderr: '',
});

test('parses the PowerShell VersionInfo JSON envelope', () => {
  const info = readWindowsExecutableVersionInfo('C:/fake/osg-desktop.exe', {
    spawn: fakeSpawnReturning({
      FileVersion: '1.0.0.0',
      ProductVersion: '1.0.0.0',
      ProductName: 'One-Click Subtitles Generator',
      CompanyName: null,
      FileDescription: 'OSG',
      InternalName: 'osg-desktop',
      OriginalFilename: 'osg-desktop.exe',
      LegalCopyright: null,
    }),
  });
  assert.equal(info.FileVersion, '1.0.0.0');
  assert.equal(info.ProductName, 'One-Click Subtitles Generator');
  assert.equal(info.CompanyName, null);
});

test('rejects a non-zero PowerShell exit', () => {
  assert.throws(
    () => readWindowsExecutableVersionInfo('C:/fake/missing.exe', {
      spawn: () => ({ error: null, status: 1, stdout: '', stderr: 'Cannot find path' }),
    }),
    /Could not read Windows executable metadata/,
  );
});

test('rejects a spawn failure', () => {
  assert.throws(
    () => readWindowsExecutableVersionInfo('C:/fake/osg-desktop.exe', {
      spawn: () => ({ error: new Error('pwsh not found') }),
    }),
    /pwsh not found/,
  );
});

test('rejects malformed JSON from the reader', () => {
  assert.throws(
    () => readWindowsExecutableVersionInfo('C:/fake/osg-desktop.exe', {
      spawn: () => ({ error: null, status: 0, stdout: 'not json', stderr: '' }),
    }),
    /not valid JSON/,
  );
});

test('rejects an empty executable path', () => {
  assert.throws(() => readWindowsExecutableVersionInfo('', { spawn: fakeSpawnReturning({}) }),
    /non-empty executable path/);
});

test('a four-part Windows version matches the three-part semantic version it pads', () => {
  assert.equal(windowsVersionMatchesSemver('1.0.0.0', '1.0.0'), true);
  assert.equal(windowsVersionMatchesSemver('1.2.3.45', '1.2.3'), true);
});

test('a mismatched Windows version does not match', () => {
  assert.equal(windowsVersionMatchesSemver('1.0.1.0', '1.0.0'), false);
  assert.equal(windowsVersionMatchesSemver(null, '1.0.0'), false);
  assert.equal(windowsVersionMatchesSemver('1.0.0.0', undefined), false);
});
