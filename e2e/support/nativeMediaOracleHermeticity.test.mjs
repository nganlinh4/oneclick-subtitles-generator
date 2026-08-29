import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import test from 'node:test';
import { URL } from 'node:url';
import { fileURLToPath } from 'node:url';

const oracleUrl = new URL('./nativeMediaOracle.js', import.meta.url);

test('pure native-media oracles load without consulting an application publication', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'osg-native-oracle-'));
  const receipt = join(cacheRoot, 'apps', 'e2e', 'receipts', 'current.json');
  mkdirSync(dirname(receipt), { recursive: true });
  writeFileSync(receipt, '{"schemaVersion":2,"forged":true}\n', 'utf8');
  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', `await import(${JSON.stringify(oracleUrl.href)})`],
      {
        cwd: dirname(fileURLToPath(oracleUrl)),
        encoding: 'utf8',
        env: { ...process.env, OSG_DEV_CACHE_ROOT: cacheRoot },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
