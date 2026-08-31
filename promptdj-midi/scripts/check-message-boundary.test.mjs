import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(import.meta.dirname, '..', 'index.tsx'), 'utf8');

test('PromptDJ uses the same exact top-window boundary in both message directions', () => {
  assert.match(source, /const host = window\.top;/u);
  assert.match(source, /event\.source !== window\.top \|\| event\.origin !== parentOrigin/u);
  assert.doesNotMatch(source, /event\.source !== window\.parent/u);
});
