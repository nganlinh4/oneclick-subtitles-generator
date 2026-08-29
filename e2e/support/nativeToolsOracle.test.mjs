import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  installedDynamicYtDlpDeliveries, resolveVerifiedNativeToolExecutable,
} from './nativeToolsOracle.js';

const delivery = (version, repository = 'yt-dlp/yt-dlp-nightly-builds') => {
  const artifactBytes = 100_000;
  const notices = [
    {
      installPath: 'licenses/yt-dlp-LICENSE.txt',
      sourceUrl: 'https://raw.githubusercontent.com/yt-dlp/yt-dlp/8377aa9555c308ca95630a28c1f91decd6c2235a/LICENSE',
      sizeBytes: 1_000,
      sha256: 'b'.repeat(64),
    },
    {
      installPath: 'licenses/yt-dlp-THIRD-PARTY.txt',
      sourceUrl: 'https://raw.githubusercontent.com/yt-dlp/yt-dlp/8377aa9555c308ca95630a28c1f91decd6c2235a/THIRD_PARTY_LICENSES.txt',
      sizeBytes: 2_000,
      sha256: 'c'.repeat(64),
    },
  ];
  return {
    tool: 'yt-dlp',
    platform: 'windows-x86_64',
    version,
    sourceRevision: '8377aa9555c308ca95630a28c1f91decd6c2235a',
    asset: 'yt-dlp.exe',
    sourceUrl: `https://github.com/${repository}/releases/download/${version}/yt-dlp.exe`,
    format: 'raw',
    selectiveExtraction: false,
    sizeBytes: artifactBytes,
    sha256: 'a'.repeat(64),
    files: [{
      sourcePath: 'yt-dlp.exe', installPath: 'bin/yt-dlp.exe', sizeBytes: artifactBytes,
      sha256: 'a'.repeat(64), role: 'yt-dlp',
    }],
    notices,
    installedBytes: artifactBytes + 3_000,
  };
};

const withStore = (context) => {
  const store = mkdtempSync(join(tmpdir(), 'osg-native-selector-'));
  const records = join(store, 'v1', 'tools', 'yt-dlp', 'deliveries');
  mkdirSync(records, { recursive: true });
  context.after(() => rmSync(store, { recursive: true, force: true }));
  return { store, records };
};

const writeRecord = (records, filename, value) => writeFileSync(
  join(records, filename),
  `${JSON.stringify({ schemaVersion: 1, githubImmutableRelease: true, delivery: value })}\n`,
);

test('dynamic selection uses validated record versions, not filenames, in raw descending order', (context) => {
  const { store, records } = withStore(context);
  writeRecord(records, 'filename-does-not-match.json', delivery('2026.08.29.010101'));
  writeRecord(records, 'duplicate-different-name.json', delivery('2026.08.29.010101'));
  writeRecord(records, 'older.json', delivery('2026.08.28.235959'));
  writeRecord(records, 'stable-repository.json', delivery('2026.08.27', 'yt-dlp/yt-dlp'));
  writeRecord(records, 'invalid-newest.json', { ...delivery('2026.08.30.000000'), sourceUrl: 'https://invalid.example/tool' });
  writeRecord(records, 'invalid-year.json', delivery('2019.08.30.000000'));
  writeRecord(records, 'invalid-time.json', delivery('2026.08.30.246060'));
  writeRecord(records, 'whitespace-month.json', delivery('2026. 8.30.010101'));
  writeRecord(records, 'whitespace-day.json', delivery('2026.08. 9.010101'));
  writeFileSync(join(records, 'extra-record-key.json'), `${JSON.stringify({
    schemaVersion: 1, githubImmutableRelease: true, delivery: delivery('2026.08.26'), extra: true,
  })}\n`);
  writeRecord(records, 'extra-delivery-key.json', { ...delivery('2026.08.25'), extra: true });
  const extraFile = delivery('2026.08.24');
  extraFile.files[0].extra = true;
  writeRecord(records, 'extra-file-key.json', extraFile);
  const extraNotice = delivery('2026.08.23');
  extraNotice.notices[0].extra = true;
  writeRecord(records, 'extra-notice-key.json', extraNotice);
  assert.deepEqual(
    installedDynamicYtDlpDeliveries(store).map(({ version }) => version),
    ['2026.08.29.010101', '2026.08.28.235959', '2026.08.27'],
  );
});

test('dynamic records use the Rust one-MiB bound and a redirected directory fails closed', (context) => {
  const { store, records } = withStore(context);
  writeFileSync(join(records, 'oversized.json'), Buffer.alloc(1024 * 1024 + 1, 0x20));
  assert.deepEqual(installedDynamicYtDlpDeliveries(store), []);

  const redirectedStore = mkdtempSync(join(tmpdir(), 'osg-native-redirected-'));
  context.after(() => rmSync(redirectedStore, { recursive: true, force: true }));
  const parent = join(redirectedStore, 'v1', 'tools', 'yt-dlp');
  const target = join(redirectedStore, 'records-target');
  mkdirSync(parent, { recursive: true });
  mkdirSync(target);
  symlinkSync(target, join(parent, 'deliveries'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => installedDynamicYtDlpDeliveries(redirectedStore),
    /redirected|ordinary directory/u,
  );
});

test('equal dynamic versions select the lexicographic-first valid record before deduplication', (context) => {
  const { store, records } = withStore(context);
  const first = delivery('2026.08.29.010101');
  const second = delivery('2026.08.29.010101');
  second.sha256 = 'd'.repeat(64);
  second.files[0].sha256 = second.sha256;
  writeRecord(records, 'a.json', first);
  writeRecord(records, 'z.json', second);
  assert.equal(installedDynamicYtDlpDeliveries(store)[0].sha256, first.sha256);
});

test('dynamic record count is bounded exactly like NativeToolManager', (context) => {
  const { store, records } = withStore(context);
  for (let index = 0; index < 65; index += 1) {
    writeFileSync(join(records, `${index}.json`), '{}\n');
  }
  assert.throws(() => installedDynamicYtDlpDeliveries(store), /count exceeds manager bound/u);
});

test('the selected dynamic delivery takes precedence and missing selected bytes fail without rollback fallback', (context) => {
  const { store, records } = withStore(context);
  const selected = delivery('2026.08.29.010101');
  writeRecord(records, 'arbitrary-record-name.json', selected);
  assert.throws(
    () => resolveVerifiedNativeToolExecutable({ storeRoot: store, tool: 'yt-dlp', role: 'yt-dlp' }),
    (error) => error?.code === 'ENOENT' && String(error.path).includes(selected.version),
  );
});
