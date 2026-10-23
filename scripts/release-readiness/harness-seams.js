'use strict';

/**
 * Every harness seam in the desktop source is compiled out of shipped builds.
 *
 * The application deliberately contains a few places where an automated run can replace something a
 * person would do — an isolated data root, a staged file-dialog selection, the CI updater fixture's
 * self-signed localhost transport. Each is guarded by a test-only Cargo feature, and each is a hole
 * in the product if that guard is ever missing or removed. The guard is what makes those seams
 * acceptable, so it is checked rather than trusted.
 *
 * Textual by necessity: this runs before anything is compiled. It looks backwards from each seam
 * token to the statement and then the function that contains it, and requires a test-only `cfg` on
 * one of them (or a test-only inner `#![cfg]` on the whole file). A seam written without one fails
 * here instead of shipping.
 */

const path = require('node:path');

const {
  REPOSITORY_ROOT,
  TAURI_DIRECTORY,
  invariant,
  readText,
  toRepositoryPath,
  walkFiles,
} = require('./shared');

const TEST_ONLY_FEATURES = Object.freeze(['e2e-automation', 'unsigned-local-build', 'ci-updater-fixture']);
const NEWLINE = String.fromCharCode(10);

function splitCfgArguments(source) {
  const arguments_ = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"' && source[index - 1] !== '\\') quoted = !quoted;
    if (quoted) continue;
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      arguments_.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  arguments_.push(source.slice(start).trim());
  return depth === 0 && !quoted && arguments_.every(Boolean) ? arguments_ : [];
}

function cfgExpressionImpliesTestOnly(expression, testOnlyFeatures) {
  const source = expression.trim();
  if (source === 'test') return true;
  const feature = source.match(/^feature\s*=\s*"([^"]+)"$/u)?.[1];
  if (feature !== undefined) return testOnlyFeatures.includes(feature);

  const composite = source.match(/^(all|any|not)\((.*)\)$/su);
  if (composite === null || composite[1] === 'not') return false;
  const children = splitCfgArguments(composite[2]);
  if (children.length === 0) return false;
  const implications = children.map((child) => (
    cfgExpressionImpliesTestOnly(child, testOnlyFeatures)
  ));
  // `any(A, B)` can ship through either arm, so every arm must be test-only. For
  // `all(A, B)`, one test-only conjunct is sufficient to compile the item out of production.
  return composite[1] === 'any' ? implications.every(Boolean) : implications.some(Boolean);
}

function lineHasTestOnlyCfgGuard(line, testOnlyFeatures, attribute = '#') {
  const prefix = attribute === '#!' ? /^#!\[cfg\((.*)\)\]$/su : /^#\[cfg\((.*)\)\]$/su;
  const expression = line.trim().match(prefix)?.[1];
  return expression !== undefined
    && cfgExpressionImpliesTestOnly(expression, testOnlyFeatures);
}

function isRustItemStart(line) {
  const source = line.trim();
  // Constant/static declarations are validated directly at their own source line. Treating a
  // function-local const as an owning item would hide the cfg attached to the containing function.
  return /^(?:(?:pub(?:\([^)]*\))?|async|const|unsafe|extern(?:\s+"[^"]+")?)\s+)*fn\b/u.test(source);
}

function isSkippable(source) {
  return source === '' || source.startsWith('//');
}

function hasAttachedTestOnlyCfg(lines, itemIndex, testOnlyFeatures) {
  for (let index = itemIndex - 1; index >= 0; index -= 1) {
    const source = lines[index].trim();
    if (isSkippable(source)) continue;
    if (!source.startsWith('#[')) return false;
    if (lineHasTestOnlyCfgGuard(source, testOnlyFeatures)) return true;
  }
  return false;
}

/** The first line of the (possibly multi-line) statement that contains `index`. */
function statementStart(lines, index) {
  let start = index;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const source = lines[cursor].trim();
    if (isSkippable(source)) continue;
    if (source.startsWith('#[') || /[;{}]$/u.test(source)) break;
    start = cursor;
  }
  return start;
}

function fileHasTestOnlyInnerCfg(lines, testOnlyFeatures) {
  const first = lines.map((line) => line.trim()).find((line) => !isSkippable(line));
  return first !== undefined && lineHasTestOnlyCfgGuard(first, testOnlyFeatures, '#!');
}

function lineHasTestOnlyOwner(lines, lineIndex, testOnlyFeatures) {
  // A cfg can own the statement itself (for example a test-only `let` or `if`) or the nearest Rust
  // item. Binding to the nearest item is intentional: accepting any cfg in a fixed look-back window
  // lets an unguarded sibling borrow the guard from the item immediately before it.
  if (hasAttachedTestOnlyCfg(lines, statementStart(lines, lineIndex), testOnlyFeatures)) return true;
  for (let index = lineIndex; index >= 0; index -= 1) {
    if (!isRustItemStart(lines[index])) continue;
    return hasAttachedTestOnlyCfg(lines, index, testOnlyFeatures);
  }
  return false;
}

/**
 * Require every desktop-source line matching `token` to be compiled only by test-only features.
 * Returns the number of guarded lines so a caller can prove the scan found something.
 */
function assertTokenIsCompiledOut(rootDirectory, { token, label, ignoreLine = () => false }) {
  const sources = walkFiles(
    path.join(rootDirectory, TAURI_DIRECTORY, 'src'),
    (candidate) => candidate.endsWith('.rs'),
  );
  invariant(sources.length > 0, 'Desktop sources are missing');

  let guarded = 0;
  for (const file of sources) {
    const relativePath = toRepositoryPath(rootDirectory, file);
    const lines = readText(rootDirectory, relativePath).split(NEWLINE);
    const wholeFileGuarded = fileHasTestOnlyInnerCfg(lines, TEST_ONLY_FEATURES);
    lines.forEach((line, index) => {
      if (!token.test(line) || line.trimStart().startsWith('//') || ignoreLine(line)) return;
      invariant(
        wholeFileGuarded || lineHasTestOnlyOwner(lines, index, TEST_ONLY_FEATURES),
        `${relativePath}:${index + 1} ${label} without a test-only cfg guard above it`,
      );
      guarded += 1;
    });
  }
  return guarded;
}

function assertHarnessSeamsAreCompiledOut(rootDirectory = REPOSITORY_ROOT) {
  return assertTokenIsCompiledOut(rootDirectory, {
    token: /OSG_E2E_[A-Z_]+/,
    label: 'reads a harness environment variable',
    // Removing a harness variable from a child process is a production hardening boundary, not
    // a harness input seam. Only declarations and reads can enable automation behavior.
    ignoreLine: (line) => /\benv_remove\s*\(/u.test(line),
  });
}

/** The CI updater fixture's insecure transport and debug port never reach a shipped build. */
function assertUpdaterFixtureSeamsAreCompiledOut(rootDirectory = REPOSITORY_ROOT) {
  return assertTokenIsCompiledOut(rootDirectory, {
    token: /danger_accept_invalid_certs|localhost:38443|--remote-debugging-port/,
    label: 'uses the CI updater fixture transport or debug port',
  });
}

module.exports = {
  assertHarnessSeamsAreCompiledOut,
  assertUpdaterFixtureSeamsAreCompiledOut,
};
