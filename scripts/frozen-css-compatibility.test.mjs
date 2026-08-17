import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FROZEN_EARLY_IMPORT,
  FROZEN_INDEX_CSS_PATH,
  FROZEN_INDEX_CSS_SOURCE_SHA256,
  FROZEN_INDEX_CSS_TRANSFORMED_SHA256,
  FROZEN_LATE_IMPORTS,
  createFrozenCssCompatibilityPlugin,
  hoistFrozenLateImports,
  normalizeFrozenCssText,
  sha256Text,
} from './frozen-css-compatibility.mjs';
import { readMutableSource, weaken } from './mutation-testing.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(repositoryRoot, FROZEN_INDEX_CSS_PATH);
const frozenSource = readMutableSource(sourcePath);

test('hoists exactly the 12 pinned imports before the first qualified rule', () => {
  assert.equal(FROZEN_LATE_IMPORTS.length, 12);
  assert.equal(Object.isFrozen(FROZEN_LATE_IMPORTS), true);
  assert.equal(FROZEN_LATE_IMPORTS.every(Object.isFrozen), true);
  assert.equal(
    sha256Text(normalizeFrozenCssText(frozenSource)),
    FROZEN_INDEX_CSS_SOURCE_SHA256,
  );

  const transformed = hoistFrozenLateImports(frozenSource);
  const normalized = normalizeFrozenCssText(transformed);
  assert.equal(sha256Text(normalized), FROZEN_INDEX_CSS_TRANSFORMED_SHA256);
  assert.equal(normalized.includes(FROZEN_EARLY_IMPORT.statement), true);
  for (const { statement } of FROZEN_LATE_IMPORTS) {
    assert.equal(normalized.includes(statement), true, statement);
  }
  assert.deepEqual(
    normalized.split('\n').filter((line) => line.startsWith('@import')),
    [FROZEN_EARLY_IMPORT, ...FROZEN_LATE_IMPORTS].map(({ statement }) => statement),
  );
  assert.equal(normalized.split('\n')[15], ':root {');
});

test('normalizes BOM, line endings, and terminal newlines without changing CSS semantics', () => {
  const portableSource = `\uFEFF${normalizeFrozenCssText(frozenSource).replaceAll('\n', '\r\n')}\r\n\r\n`;
  const transformed = hoistFrozenLateImports(portableSource);
  assert.equal(transformed.startsWith('\uFEFF'), false);
  assert.equal(transformed.includes('\r'), false);
  assert.equal(transformed.endsWith('\n'), true);
  assert.equal(transformed, hoistFrozenLateImports(frozenSource));
  assert.equal(
    sha256Text(normalizeFrozenCssText(transformed)),
    FROZEN_INDEX_CSS_TRANSFORMED_SHA256,
  );
});

test('fails closed on unrelated frozen source drift', () => {
  const drifted = weaken(frozenSource, '--ms-wght: 600;', '--ms-wght: 601;', { expected: 1 });
  assert.throws(
    () => hoistFrozenLateImports(drifted),
    /source integrity mismatch/,
  );
});

test('fails closed when a pinned late import is missing or duplicated', () => {
  const [{ statement }] = FROZEN_LATE_IMPORTS;
  assert.throws(
    () => hoistFrozenLateImports(weaken(frozenSource, statement, '', { expected: 1 })),
    /expected exactly 13 @import statements; found 12/,
  );
  assert.throws(
    () => hoistFrozenLateImports(
      weaken(frozenSource, statement, `${statement}\r\n${statement}`, { expected: 1 }),
    ),
    /expected exactly 13 @import statements; found 14/,
  );
});

test('fails closed when pinned imports are reordered, altered, moved, or extended', () => {
  const [first, second] = FROZEN_LATE_IMPORTS;
  const reordered = weaken(
    weaken(
      weaken(frozenSource, first.statement, '__FIRST_IMPORT__', { expected: 1 }),
      second.statement,
      first.statement,
      { expected: 1 },
    ),
    '__FIRST_IMPORT__',
    second.statement,
    { expected: 1 },
  );
  const altered = weaken(
    frozenSource,
    first.statement,
    "@import url('./different-fonts.css');",
    { expected: 1 },
  );
  const moved = weaken(
    weaken(frozenSource, first.statement, '', { expected: 1 }),
    second.statement,
    `${first.statement}\n${second.statement}`,
    { expected: 1 },
  );
  const extended = weaken(
    frozenSource,
    FROZEN_LATE_IMPORTS.at(-1).statement,
    `${FROZEN_LATE_IMPORTS.at(-1).statement}\r\n@import url('./unreviewed.css');`,
    { expected: 1 },
  );
  for (const candidate of [reordered, altered, moved]) {
    assert.throws(() => hoistFrozenLateImports(candidate), /@import inventory drifted/);
  }
  assert.throws(
    () => hoistFrozenLateImports(extended),
    /expected exactly 13 @import statements; found 14/,
  );
});

test('Vite pre-transform applies to the frozen entry in development and production', () => {
  const plugin = createFrozenCssCompatibilityPlugin({ root: repositoryRoot });
  assert.equal(plugin.apply, undefined);
  assert.equal(plugin.enforce, 'pre');
  assert.equal(plugin.transform(frozenSource, `${sourcePath}.lookalike`), null);
  assert.equal(
    plugin.transform(normalizeFrozenCssText(frozenSource), resolve(repositoryRoot, 'src/styles/other.css')),
    null,
  );
  assert.equal(
    plugin.transform('a {\r\n  color: red;\r\n}\r\n', resolve(repositoryRoot, 'src/styles/other.css')).code,
    'a {\n  color: red;\n}\n',
  );
  assert.equal(
    plugin.transform('a {\r\n  color: red;\r\n}\r\n', resolve(repositoryRoot, '..', 'other.css')),
    null,
  );

  const result = plugin.transform(frozenSource, `${sourcePath}?direct`);
  assert.equal(
    sha256Text(normalizeFrozenCssText(result.code)),
    FROZEN_INDEX_CSS_TRANSFORMED_SHA256,
  );
  assert.throws(
    () => plugin.transform(`${frozenSource}\n/* drift */`, sourcePath),
    /source integrity mismatch/,
  );
});
