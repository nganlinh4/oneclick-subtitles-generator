#!/usr/bin/env node

/**
 * Every capability input must be supplied by something that ships.
 *
 * WHY THIS EXISTS. `resolveFontIdentity` took `managedPackInstalled` and defaulted it to `false`.
 * Only tests ever passed it. So in the product the managed font package was permanently reported as
 * absent, the default subtitle font resolved to nothing, and the editor could not draw a subtitle
 * preview on any installation — while every font test passed, because each one constructed the
 * `true` that production never provided.
 *
 * That is the shape this gate refuses: a parameter whose absence disables a feature, a default that
 * makes absence silent, and no shipping caller that fills it in. The unit tests could not catch it,
 * being the only caller, and a type checker could not, the default having made it optional. What
 * catches it is asking who supplies the value in code that is not a test.
 *
 * WHAT IT CHECKS. For every parameter in `src/` whose name reads as a capability — installed,
 * available, enabled, supported, ready, allowed, permitted — and whose default is `false` or
 * `null`, at least one non-test source must pass it: as an object property, as shorthand, or as a
 * JSX prop.
 *
 * WHAT IT CANNOT CHECK, because pretending otherwise makes a gate that gets trusted wrongly: that
 * the value passed is CORRECT, that the supplying call site is reachable at runtime, or that a
 * capability computed inside a function rather than taken as a parameter is right. It answers one
 * question exactly — "does anything that ships fill this in?" — and that answer was "no" for the
 * defect that motivated it.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.join(ROOT, 'src');
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '__pycache__']);

/** Words that make a parameter a claim about what the machine can do. */
/** A backslash and a newline, built rather than written; see `suppliedBy` for why. */
const ESCAPE = String.fromCharCode(92);
const NEWLINE = String.fromCharCode(10);

const CAPABILITY_WORDS = /(installed|available|enabled|supported|ready|allowed|permitted)$/i;

/** `  managedPackInstalled = false,` — a destructured parameter defaulting to unavailable. */
const DECLARATION = /^\s{2,}([A-Za-z_$][\w$]*)\s*=\s*(false|null)\s*,?\s*$/;

const isTestSource = (file) => /\.(test|spec)\.[jt]sx?$/.test(file) || file.includes('__tests__');

const sources = (directory) => {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) found.push(...sources(full));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
};

const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');

/**
 * Call sites that supply `name`, as an object property, shorthand, or JSX prop.
 *
 * Deliberately textual. A parser would be more precise, and would also have to resolve every
 * indirection this codebase uses to pass options along; the question here is only whether the name
 * appears as a supplied value anywhere outside a test, and text answers that without pretending to
 * more rigour than it has.
 */
const suppliedBy = (name, files, declaringFile) => {
  // Built by concatenation rather than written as escapes inside a template literal, where a lone
  // backslash-s degrades to a bare "s" and the check silently matches nothing. The first version of
  // this file did exactly that and reported nine capabilities as unsupplied, several of which are
  // supplied on the line above the one it was reading.
  const boundary = '(^|[^A-Za-z0-9_$])';
  const spaces = `[${ESCAPE}s]*`;
  const property = new RegExp(`${boundary}${name}${spaces}:`);
  const shorthand = new RegExp(`${boundary}${name}${spaces}[,}]`);
  const jsxProp = new RegExp(`${boundary}${name}${spaces}=${spaces}[{"']`);
  return files.filter((file) => {
    if (isTestSource(file)) return false;
    const source = fs.readFileSync(file, 'utf8');
    if (file === declaringFile) {
      // The declaration itself is not a supplier, so the defaulting lines go before asking.
      const withoutDeclaration = source
        .split(NEWLINE).filter((line) => !DECLARATION.test(line)).join(NEWLINE);
      return property.test(withoutDeclaration) || jsxProp.test(withoutDeclaration);
    }
    return property.test(source) || shorthand.test(source) || jsxProp.test(source);
  });
};

/** How many capability parameters exist at all, so "passed" can never mean "found none". */
const declarationCount = (sourceRoot = SOURCE_ROOT) => sources(sourceRoot)
  .filter((file) => !isTestSource(file))
  .reduce((total, file) => total + fs.readFileSync(file, 'utf8').split(NEWLINE)
    .filter((line) => {
      const match = DECLARATION.exec(line);
      return match !== null && CAPABILITY_WORDS.test(match[1]);
    }).length, 0);

const collectUnsupplied = (sourceRoot = SOURCE_ROOT) => {
  const files = sources(sourceRoot);
  const declarations = [];
  for (const file of files) {
    if (isTestSource(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const match = DECLARATION.exec(line);
      if (match !== null && CAPABILITY_WORDS.test(match[1])) {
        declarations.push({ file, line: index + 1, name: match[1], fallback: match[2] });
      }
    });
  }
  return declarations
    .map((declaration) => ({
      ...declaration,
      suppliers: suppliedBy(declaration.name, files, declaration.file),
    }))
    .filter((declaration) => declaration.suppliers.length === 0);
};

const run = (sourceRoot = SOURCE_ROOT) => {
  const unsupplied = collectUnsupplied(sourceRoot);
  if (unsupplied.length > 0) {
    const lines = unsupplied.map((item) => (
      `  ${relative(item.file)}:${item.line} takes "${item.name}", defaults it to ${item.fallback}, `
        + 'and no shipping source supplies it'
    ));
    throw new Error(`Capability inputs no production caller provides:${NEWLINE}${lines.join(NEWLINE)}`);
  }
  console.log(
    `Capability input check passed: ${declarationCount(sourceRoot)} capability parameter(s) `
      + 'all have a shipping supplier.',
  );
};

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { CAPABILITY_WORDS, DECLARATION, collectUnsupplied, declarationCount, run };
