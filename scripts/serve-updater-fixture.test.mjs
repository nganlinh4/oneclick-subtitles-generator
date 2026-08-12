import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseArguments,
  requestTarget,
  validateFixture,
} from './serve-updater-fixture.mjs';

const SIGNATURE = Buffer.from('x'.repeat(128)).toString('base64');

const fixture = (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-updater-fixture-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'update.exe'), Buffer.from('MZ fixture'));
  fs.writeFileSync(path.join(root, 'latest.json'), JSON.stringify({
    version: '1.0.0-rc.2',
    notes: 'Isolated signed updater smoke',
    pub_date: '2026-08-12T00:00:00Z',
    platforms: {
      'windows-x86_64-nsis': {
        signature: SIGNATURE,
        url: 'https://localhost:38443/update.exe',
      },
    },
  }));
  return root;
};

test('fixture arguments accept only three path-bearing host-side inputs', () => {
  const parsed = parseArguments([
    '--root', 'root', '--pfx', 'certificate.pfx', '--ready-file', 'ready.json',
  ]);
  assert.equal(parsed.root, path.resolve('root'));
  assert.throws(() => parseArguments([
    '--root', 'root', '--pfx', 'certificate.pfx', '--ready-file', 'ready.json', '--port', '443',
  ]), /Only/);
  assert.throws(() => parseArguments(['--root', 'root', '--root', 'again']), /Duplicate/);
});

test('fixture validation requires one exact signed Windows NSIS release', (context) => {
  const root = fixture(context);
  assert.deepEqual(validateFixture(root), {
    manifestPath: path.join(root, 'latest.json'),
    updatePath: path.join(root, 'update.exe'),
    updateBytes: 10,
    version: '1.0.0-rc.2',
  });
  fs.writeFileSync(path.join(root, 'extra.txt'), 'unreviewed');
  assert.throws(() => validateFixture(root), /exactly/);
});

test('fixture validation rejects endpoint, platform, schema, and signature drift', (context) => {
  const root = fixture(context);
  const manifestPath = path.join(root, 'latest.json');
  const original = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.platforms['windows-x86_64-nsis'].url = 'https://example.com/update.exe'; },
    (value) => { value.platforms.windows = value.platforms['windows-x86_64-nsis']; },
    (value) => { value.platforms['windows-x86_64-nsis'].signature = 'short'; },
  ]) {
    const value = JSON.parse(JSON.stringify(original));
    mutate(value);
    fs.writeFileSync(manifestPath, JSON.stringify(value));
    assert.throws(() => validateFixture(root));
  }
});

test('fixture routes are exact, read-only, and bound to the reviewed Host header', () => {
  const request = (url, method = 'GET', host = 'localhost:38443') => ({
    url,
    method,
    headers: { host },
  });
  assert.equal(requestTarget(request('/latest.json')), 'manifest');
  assert.equal(requestTarget(request('/update.exe', 'HEAD')), 'update');
  assert.throws(() => requestTarget(request('/update.exe?query=1')), /route/);
  assert.throws(() => requestTarget(request('/update.exe', 'POST')), /GET and HEAD/);
  assert.throws(() => requestTarget(request('/update.exe', 'GET', '127.0.0.1:38443')), /Host/);
});
