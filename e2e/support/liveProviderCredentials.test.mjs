import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseDotEnv, readGeminiCredentialPool } from './liveProviderCredentials.js';

test('dotenv parsing accepts the reviewed indexed pool without interpreting unrelated values', () => {
  assert.deepEqual(parseDotEnv([
    '# comment',
    'GEMINI_API_KEY=first-fixture',
    'export GEMINI_API_KEY_2="second-fixture"',
    "GEMINI_API_KEY_20='twentieth-fixture'",
    'OTHER=value=with=equals',
  ].join('\n')), {
    GEMINI_API_KEY: 'first-fixture',
    GEMINI_API_KEY_2: 'second-fixture',
    GEMINI_API_KEY_20: 'twentieth-fixture',
    OTHER: 'value=with=equals',
  });
});

test('the process environment wins per slot and only slots one through twenty are admitted', () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-live-provider-credentials-'));
  const envPath = join(root, '.env');
  writeFileSync(envPath, [
    'GEMINI_API_KEY=file-primary',
    'GEMINI_API_KEY_2=file-second',
    'GEMINI_API_KEY_20=file-twentieth',
    'GEMINI_API_KEY_21=outside-bound',
  ].join('\n'));
  const credentials = readGeminiCredentialPool({
    envPath,
    environment: { GEMINI_API_KEY_2: 'process-second' },
  });
  assert.deepEqual(credentials, [
    { name: 'GEMINI_API_KEY', value: 'file-primary' },
    { name: 'GEMINI_API_KEY_2', value: 'process-second' },
    { name: 'GEMINI_API_KEY_20', value: 'file-twentieth' },
  ]);
});
