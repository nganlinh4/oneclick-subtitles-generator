import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const FROZEN_INDEX_CSS_PATH = 'src/styles/index.css';
export const FROZEN_INDEX_CSS_SOURCE_SHA256 =
  '6a44224dbe1b93be272a1369a55fffe2faab833f711a3a9c2f02a5abb3e31767';
export const FROZEN_INDEX_CSS_TRANSFORMED_SHA256 =
  '79bc935010d7bf61b197898cc4b93c219c536cdd7664e5fd668f3abe0dbea28c';
export const FROZEN_EARLY_IMPORT = Object.freeze({
  line: 2,
  statement:
    "@import url('https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,GRAD@24,600,0&display=block');",
});
export const FROZEN_LATE_IMPORTS = Object.freeze([
  Object.freeze({
    line: 28,
    statement:
      "@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap');",
  }),
  Object.freeze({
    line: 29,
    statement:
      "@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;700&family=Noto+Sans:wght@400;500;700&family=Noto+Serif:wght@400;700&family=Nanum+Gothic:wght@400;700;800&family=Nanum+Gothic+Coding&family=Nanum+Myeongjo:wght@400;700&family=Gowun+Dodum&display=swap');",
  }),
  Object.freeze({
    line: 30,
    statement:
      "@import url('https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@400;600&display=swap');",
  }),
  Object.freeze({
    line: 32,
    statement:
      "@import url('https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600&family=Montserrat+Alternates:wght@400;500;600&family=Sarabun:wght@400;500;600&family=Josefin+Sans:wght@400;500;600&display=swap');",
  }),
  Object.freeze({
    line: 33,
    statement:
      "@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+Vietnamese:wght@400;500;600&display=swap');",
  }),
  Object.freeze({
    line: 34,
    statement: "@import url('./material-tokens.css');",
  }),
  Object.freeze({
    line: 35,
    statement: "@import url('./components/custom-slider.css');",
  }),
  Object.freeze({
    line: 36,
    statement: "@import url('./album-art-fix.css');",
  }),
  Object.freeze({
    line: 37,
    statement: "@import url('./floating-scrollbar.css');",
  }),
  Object.freeze({
    line: 38,
    statement: "@import url('./font-overrides.css');",
  }),
  Object.freeze({
    line: 39,
    statement: "@import url('./components/LiquidGlass.css');",
  }),
  Object.freeze({
    line: 41,
    statement: "@import url('./components/form-controls.css');",
  }),
]);

const FROZEN_IMPORTS = Object.freeze([
  FROZEN_EARLY_IMPORT,
  ...FROZEN_LATE_IMPORTS,
]);
const LATE_IMPORT_LINES = new Set(FROZEN_LATE_IMPORTS.map(({ line }) => line));

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`Frozen CSS compatibility check failed: ${message}`);
  }
}

export function normalizeFrozenCssText(source) {
  invariant(typeof source === 'string', 'src/styles/index.css must be UTF-8 text');
  return source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/g, '');
}

export function sha256Text(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function collectImports(lines) {
  return lines.flatMap((statement, index) => (
    statement.trimStart().startsWith('@import')
      ? [{ line: index + 1, statement }]
      : []
  ));
}

function assertFrozenImportInventory(lines) {
  const imports = collectImports(lines);
  invariant(
    imports.length === FROZEN_IMPORTS.length,
    `expected exactly ${FROZEN_IMPORTS.length} @import statements; found ${imports.length}`,
  );
  for (let index = 0; index < FROZEN_IMPORTS.length; index += 1) {
    const expected = FROZEN_IMPORTS[index];
    const actual = imports[index];
    invariant(
      actual.line === expected.line && actual.statement === expected.statement,
      `@import inventory drifted at entry ${index + 1}; expected line ${expected.line} ${JSON.stringify(expected.statement)}, found line ${actual.line} ${JSON.stringify(actual.statement)}`,
    );
  }
  invariant(
    lines[3] === ':root {',
    'the frozen source must retain its pre-port import inventory before compatibility hoisting',
  );
}

function splitLinesPreservingEndings(source) {
  const lines = [];
  const newline = /\r\n|\r|\n/g;
  let start = 0;
  for (let match = newline.exec(source); match; match = newline.exec(source)) {
    lines.push(source.slice(start, newline.lastIndex));
    start = newline.lastIndex;
  }
  if (start < source.length) {
    lines.push(source.slice(start));
  }
  return lines;
}

export function hoistFrozenLateImports(source) {
  const normalizedSource = normalizeFrozenCssText(source);
  const sourceLines = normalizedSource.split('\n');
  assertFrozenImportInventory(sourceLines);

  const sourceDigest = sha256Text(normalizedSource);
  invariant(
    sourceDigest === FROZEN_INDEX_CSS_SOURCE_SHA256,
    `source integrity mismatch for ${FROZEN_INDEX_CSS_PATH}; expected ${FROZEN_INDEX_CSS_SOURCE_SHA256}, found ${sourceDigest}`,
  );

  const physicalLines = splitLinesPreservingEndings(source);
  const hoistedImports = physicalLines.filter((_, index) => LATE_IMPORT_LINES.has(index + 1));
  const remainingLines = physicalLines.filter((_, index) => !LATE_IMPORT_LINES.has(index + 1));
  invariant(
    hoistedImports.length === FROZEN_LATE_IMPORTS.length,
    `expected to hoist exactly ${FROZEN_LATE_IMPORTS.length} physical lines; found ${hoistedImports.length}`,
  );
  remainingLines.splice(FROZEN_EARLY_IMPORT.line, 0, ...hoistedImports);
  const transformed = remainingLines.join('');

  const normalizedTransformed = normalizeFrozenCssText(transformed);
  const transformedDigest = sha256Text(normalizedTransformed);
  invariant(
    transformedDigest === FROZEN_INDEX_CSS_TRANSFORMED_SHA256,
    `transformed source integrity mismatch; expected ${FROZEN_INDEX_CSS_TRANSFORMED_SHA256}, found ${transformedDigest}`,
  );
  const remainingImports = collectImports(normalizedTransformed.split('\n'));
  invariant(
    remainingImports.length === FROZEN_IMPORTS.length &&
      remainingImports.every(({ line, statement }, index) => (
        line === index + FROZEN_EARLY_IMPORT.line &&
        statement === FROZEN_IMPORTS[index].statement
      )),
    'the transform must preserve every frozen import before the first qualified rule',
  );
  invariant(
    normalizedTransformed.split('\n')[FROZEN_IMPORTS.length + 2] === ':root {',
    'the first qualified rule must follow the complete frozen import block',
  );
  return transformed;
}

function comparablePath(value) {
  const absolute = resolve(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function createFrozenCssCompatibilityPlugin({ root = process.cwd() } = {}) {
  const target = comparablePath(resolve(root, FROZEN_INDEX_CSS_PATH));
  return {
    name: 'osg-frozen-css-compatibility',
    enforce: 'pre',
    transform(source, id) {
      const cleanId = id.split(/[?#]/, 1)[0];
      if (comparablePath(cleanId) !== target) return null;
      return {
        code: hoistFrozenLateImports(source),
        map: null,
      };
    },
  };
}
