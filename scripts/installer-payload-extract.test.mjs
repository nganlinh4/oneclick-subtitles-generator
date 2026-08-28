import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);

import {
  extractNsisInstallerPayload,
  locateSevenZip,
  sevenZipAvailability,
  walkFiles,
} from './installer-payload-extract.mjs';

const withTempDirectory = (callback) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-extract-helper-test-'));
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

test('walkFiles recurses and never follows a symlink', () => {
  withTempDirectory((root) => {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    fs.writeFileSync(path.join(root, 'nested', 'b.txt'), 'b');
    try {
      fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'link.txt'));
    } catch {
      // Creating symlinks can require elevated privileges on Windows; the assertion below still
      // holds either way, so a sandbox without that privilege just exercises fewer entries.
    }
    const files = walkFiles(root).map((file) => path.relative(root, file).split(path.sep).join('/')).sort();
    assert.deepEqual(files, ['a.txt', 'nested/b.txt']);
  });
});

/** The real, ambient `7zip-bin-full` resolves via Node's own parent-directory module search even
 * from inside this worktree (it walks up to the checkout's shared `node_modules`), so these tests
 * inject a `requireLockedPackage` that behaves as if the package were absent, to exercise the
 * fallback and failure paths deterministically regardless of what happens to be installed. */
const packageNotInstalled = () => { throw new Error('Cannot find module'); };

test('locateSevenZip prefers the locked package when it resolves', () => {
  const located = locateSevenZip({
    requireLockedPackage: () => ({ path7z: thisFile }),
  });
  assert.deepEqual(located, { executable: thisFile, source: '7zip-bin-full' });
});

test('locateSevenZip falls back to a system probe when the locked package is unavailable', () => {
  const located = locateSevenZip({
    requireLockedPackage: packageNotInstalled,
    probe: (name) => (name === '7z' || name === '7z.exe'
      ? { error: null, status: 0, stdout: '7-Zip', stderr: '' }
      : { error: new Error('not found') }),
  });
  assert.ok(located);
  assert.equal(located.source, 'system PATH');
});

test('locateSevenZip returns null when nothing is found', () => {
  const located = locateSevenZip({
    requireLockedPackage: packageNotInstalled,
    probe: () => ({ error: new Error('not found') }),
  });
  assert.equal(located, null);
});

test('sevenZipAvailability reports a bounded, honest shape either way', () => {
  const unavailable = sevenZipAvailability({
    requireLockedPackage: packageNotInstalled,
    probe: () => ({ error: new Error('not found') }),
  });
  assert.deepEqual(unavailable, { available: false, executable: null, source: null });
});

test('extractNsisInstallerPayload rejects a missing installer path', () => {
  assert.throws(() => extractNsisInstallerPayload('C:/does/not/exist.exe'), /does not exist/);
});

test('extractNsisInstallerPayload explains the alternative when 7-Zip is unavailable', () => {
  withTempDirectory((root) => {
    const installer = path.join(root, 'setup.exe');
    fs.writeFileSync(installer, 'MZ-fake-installer');
    assert.throws(
      () => extractNsisInstallerPayload(installer, { locate: () => null }),
      /--payload-dir/,
    );
  });
});

test('extractNsisInstallerPayload extracts the outer archive and every nested .7z it contains', () => {
  withTempDirectory((root) => {
    const installer = path.join(root, 'setup.exe');
    fs.writeFileSync(installer, 'MZ-fake-installer');
    const calls = [];
    const fakeExtract = (executable, archive, destination) => {
      calls.push({ archive, destination });
      fs.mkdirSync(destination, { recursive: true });
      if (archive === installer) {
        // The outer extraction reveals one nested application archive, as a real NSIS package would.
        fs.writeFileSync(path.join(destination, 'app.7z'), 'nested-archive-bytes');
      } else {
        fs.writeFileSync(path.join(destination, 'osg-desktop.exe'), 'MZ-fake-exe');
      }
    };
    const extractionRoot = extractNsisInstallerPayload(installer, {
      extract: fakeExtract,
      locate: () => ({ executable: 'fake-7z', source: 'test' }),
      tmpRoot: root,
    });
    try {
      assert.equal(calls.length, 2, 'the outer archive and the one nested .7z should each be extracted once');
      const nested = walkFiles(extractionRoot).some((file) => path.basename(file) === 'osg-desktop.exe');
      assert.ok(nested, 'the nested application archive contents should be reachable under the extraction root');
    } finally {
      fs.rmSync(extractionRoot, { recursive: true, force: true });
    }
  });
});

test('extractNsisInstallerPayload cleans up its temporary directory when extraction itself fails', () => {
  withTempDirectory((root) => {
    const installer = path.join(root, 'setup.exe');
    fs.writeFileSync(installer, 'MZ-fake-installer');
    let capturedDestination;
    assert.throws(
      () => extractNsisInstallerPayload(installer, {
        extract: (executable, archive, destination) => {
          capturedDestination = destination;
          throw new Error('7-Zip extraction failed');
        },
        locate: () => ({ executable: 'fake-7z', source: 'test' }),
        tmpRoot: root,
      }),
      /7-Zip extraction failed/,
    );
    assert.equal(fs.existsSync(capturedDestination), false);
  });
});
