#!/usr/bin/env node

/**
 * Every package this repository's own sources reach for must be declared by a manifest that covers
 * them.
 *
 * WHY THIS EXISTS. `esbuild` was required by four scripts and by the production frontend build for
 * an unknown length of time while being declared by nothing. It resolved only because a deleted npm
 * workspace's dependency happened to hoist it into the root `node_modules`. Deleting that workspace
 * removed the hoist and the scripts broke — which is the good outcome; the bad one was every CI run
 * until then passing while the dependency was undeclared.
 *
 * WHY THE GATE THAT LOOKED LIKE IT COVERED THIS DOES NOT. `npm run check:dependencies` is
 * `npm ls --all`, which compares the INSTALLED TREE to the manifests. It never reads an `import` or
 * a `require`, so a source can depend on a package no manifest names and `npm ls` still exits 0.
 * That was measured, not assumed: a probe file requiring a package that does not exist at all
 * leaves `npm ls --all` at exit 0.
 *
 * WHAT THIS CHECKS. Every bare specifier in the sources below resolves to a package declared by the
 * nearest covering manifest or by the workspace root, because npm hoists workspace dependencies and
 * a script legitimately reads them. Node builtins are exempt. Relative and absolute paths are not
 * dependencies. Type-only imports are still runtime resolutions for the loaders here, so they count.
 *
 * WHAT IT CANNOT CHECK, stated because the gap is the interesting part: a package named only in
 * configuration DATA rather than in an import. `vite.config.mjs` sets `cssMinify: 'esbuild'`, and
 * Vite then imports esbuild lazily on the product build path — no `import` statement in this
 * repository mentions it. Those are listed in CONFIGURED_CONSUMERS below and must be maintained by
 * hand; there is no way to derive them, so the honest thing is to make the list visible rather than
 * to pretend the scan is complete.
 */

const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const ROOT = path.resolve(__dirname, '..');

/** Source roots this repository owns. Vendored trees are somebody else's manifest problem. */
const SCANNED = Object.freeze([
  'scripts',
  'src',
  'promptdj-midi/src',
  'vite.config.mjs',
  'vitest.config.mjs',
]);

const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'target', '__pycache__']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

/**
 * Packages reached through configuration rather than through an import statement.
 *
 * Each entry needs the file that names it and what loads it, so the next reader can re-verify the
 * claim instead of trusting this list. Adding one without that evidence defeats the point.
 */
const CONFIGURED_CONSUMERS = Object.freeze([
  {
    package: 'esbuild',
    declaredBy: 'package.json',
    reason: "vite.config.mjs sets cssMinify: 'esbuild'; Vite imports it lazily when minifying the "
      + 'shipped CSS, so the production frontend build depends on it with no import statement here.',
  },
]);

const BUILTINS = new Set(builtinModules);

const isBuiltin = (specifier) => (
  specifier.startsWith('node:') || BUILTINS.has(specifier)
);

/** `@scope/name/sub` -> `@scope/name`; `pkg/sub` -> `pkg`. */
const packageNameOf = (specifier) => {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
};

const SPECIFIER_PATTERNS = Object.freeze([
  /(?:^|[\s;{(])import\s+(?:[^'"()]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
  // `export { x } from 'pkg'` is a dependency edge too, and it was missed until a fixture asked.
  /(?:^|[\s;{(])export\s+[^'"()]*?\sfrom\s+['"]([^'"]+)['"]/g,
  /(?:^|[^.\w])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:^|[^.\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]);

const BACKSLASH = String.fromCharCode(92);
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = new RegExp(String.raw`(^|[^:'"\`\\])\/\/[^\n]*`, 'g');

const withoutComments = (source) => source
  .replace(BLOCK_COMMENT, '')
  .replace(LINE_COMMENT, '$1');

/**
 * True when a match sits inside a surrounding string literal rather than in code.
 *
 * A text scan cannot tell `require('x')` from the same characters quoted inside a fixture, and this
 * repository's own tests write fixture modules as double-quoted or backticked source. Counting
 * unescaped outer quotes before the match on its line separates the two, because an import
 * specifier is written with single quotes here and a fixture wrapping it is not.
 *
 * It is a heuristic and says so: a single-quoted outer string containing a double-quoted specifier
 * would fool it. That shape does not occur here, and the failure direction is a false POSITIVE — a
 * reported dependency that is not one — which is noticed immediately rather than shipped.
 */
const insideStringLiteral = (source, index) => {
  const lineStart = source.lastIndexOf('\n', index) + 1;
  const prefix = source.slice(lineStart, index);
  for (const quote of ['"', '`']) {
    let count = 0;
    for (let at = 0; at < prefix.length; at += 1) {
      if (prefix[at] === BACKSLASH) { at += 1; continue; }
      if (prefix[at] === quote) count += 1;
    }
    if (count % 2 === 1) return true;
  }
  return false;
};

const specifiersIn = (rawSource) => {
  const source = withoutComments(rawSource);
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
      // The specifier's own offset, not the match's: these patterns capture the character BEFORE
      // the keyword, and testing from there reads one quote short of the truth.
      if (insideStringLiteral(source, match.index + match[0].indexOf(specifier))) continue;
      found.add(specifier);
    }
  }
  return found;
};

const walk = (entry, repositoryRoot = ROOT) => {
  const absolute = path.resolve(repositoryRoot, entry);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) {
    return SOURCE_EXTENSIONS.has(path.extname(absolute)) ? [absolute] : [];
  }
  const files = [];
  for (const child of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (child.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(child.name)) continue;
      files.push(...walk(path.join(absolute, child.name), repositoryRoot));
      continue;
    }
    const childPath = path.join(absolute, child.name);
    if (SOURCE_EXTENSIONS.has(path.extname(childPath))) files.push(childPath);
  }
  return files;
};

const manifestAt = (directory) => {
  const candidate = path.join(directory, 'package.json');
  if (!fs.existsSync(candidate)) return null;
  try {
    return JSON.parse(fs.readFileSync(candidate, 'utf8'));
  } catch {
    return null;
  }
};

const declaredIn = (manifest) => new Set([
  ...Object.keys(manifest?.dependencies ?? {}),
  ...Object.keys(manifest?.devDependencies ?? {}),
  ...Object.keys(manifest?.peerDependencies ?? {}),
  ...Object.keys(manifest?.optionalDependencies ?? {}),
]);

/**
 * Every package name a file may use: its nearest manifest, plus the workspace root's.
 *
 * The root is included because npm hoists, and a workspace script reading a root devDependency is
 * ordinary rather than a smell. What is not ordinary is a name that appears in no manifest at all.
 */
const allowedFor = (file, rootManifest, repositoryRoot = ROOT) => {
  const allowed = declaredIn(rootManifest);
  let directory = path.dirname(file);
  while (directory.startsWith(repositoryRoot)) {
    const manifest = manifestAt(directory);
    if (manifest !== null) for (const name of declaredIn(manifest)) allowed.add(name);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return allowed;
};

const collectUndeclared = (repositoryRoot = ROOT) => {
  const rootManifest = manifestAt(repositoryRoot);
  const undeclared = [];
  for (const entry of SCANNED) {
    for (const file of walk(entry, repositoryRoot)) {
      const allowed = allowedFor(file, rootManifest, repositoryRoot);
      const source = fs.readFileSync(file, 'utf8');
      for (const specifier of specifiersIn(source)) {
        if (isBuiltin(specifier)) continue;
        const name = packageNameOf(specifier);
        if (allowed.has(name)) continue;
        undeclared.push({
          file: path.relative(repositoryRoot, file).replaceAll('\\', '/'),
          specifier,
          package: name,
        });
      }
    }
  }
  return undeclared;
};

/**
 * The configured consumers really are declared where they claim to be.
 *
 * Without this the hand-maintained list would rot into a list of packages nobody ships, which is
 * exactly the kind of stale allowlist that makes the next reader distrust the gate.
 */
const collectStaleConfiguredConsumers = (repositoryRoot = ROOT) => {
  const stale = [];
  for (const consumer of CONFIGURED_CONSUMERS) {
    const manifest = manifestAt(path.join(repositoryRoot, path.dirname(consumer.declaredBy)));
    if (manifest === null || !declaredIn(manifest).has(consumer.package)) {
      stale.push(consumer);
    }
  }
  return stale;
};

const run = (repositoryRoot = ROOT) => {
  const undeclared = collectUndeclared(repositoryRoot);
  const stale = collectStaleConfiguredConsumers(repositoryRoot);
  if (undeclared.length > 0 || stale.length > 0) {
    const lines = [
      ...undeclared.map(
        (item) => `  ${item.file} imports "${item.specifier}" but no manifest declares ${item.package}`,
      ),
      ...stale.map(
        (item) => `  configured consumer ${item.package} is not declared by ${item.declaredBy}`,
      ),
    ];
    throw new Error(`Undeclared dependencies:\n${lines.join('\n')}`);
  }
  const scanned = SCANNED.flatMap((entry) => walk(entry, repositoryRoot)).length;
  console.log(
    `Declared-dependency check passed: ${scanned} sources scanned, `
      + `${CONFIGURED_CONSUMERS.length} configured consumer(s) verified.`,
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

module.exports = {
  CONFIGURED_CONSUMERS,
  collectStaleConfiguredConsumers,
  collectUndeclared,
  packageNameOf,
  run,
};
