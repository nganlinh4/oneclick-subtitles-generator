// Repository and e2e source readers shared by the automation-safety contracts.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export const E2E_ROOT = join(import.meta.dirname, '..');
export const REPOSITORY_ROOT = join(E2E_ROOT, '..');
export const read = (...parts) => readFileSync(join(REPOSITORY_ROOT, ...parts), 'utf8');

const SPLIT_MODULE_EXTENSION = /\.(?:m?js|rs)$/u;
// Rust test modules (`tests.rs`, `tests/`) are not implementation, so pins never match them.
const isImplementationFile = (name) => SPLIT_MODULE_EXTENSION.test(name) && name !== 'tests.rs';

/**
 * A public module plus the implementation modules in its same-named sibling directory, joined so
 * source pins cover all of it: `support/environment.js` + `support/environment/*.js`, or a Rust
 * `foo.rs` + the non-test `foo/*.rs` submodules.
 */
export const readSplitModule = (...parts) => {
  const directory = join(REPOSITORY_ROOT, ...parts).replace(SPLIT_MODULE_EXTENSION, '');
  const implementation = existsSync(directory)
    ? readdirSync(directory).filter(isImplementationFile).sort()
      .map((name) => readFileSync(join(directory, name), 'utf8'))
    : [];
  return [read(...parts), ...implementation].join('\n');
};

/** Every non-test .js/.mjs file below `root`, recursively. */
export const sourceFilesBelow = (root) => {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:js|mjs)$/u.test(entry.name) && !/\.test\.m?js$/u.test(entry.name)) files.push(path);
    }
  };
  visit(root);
  return files;
};

// Journeys and the step modules under journeys/steps/ they import: a step module is journey code.
export const journeySources = () => sourceFilesBelow(join(E2E_ROOT, 'journeys'))
  .map((path) => ({ name: relative(E2E_ROOT, path), source: readFileSync(path, 'utf8') }));
