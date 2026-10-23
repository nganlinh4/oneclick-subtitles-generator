'use strict';

// Fixture helpers shared by the release-readiness test files.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');

function writeFile(root, relativePath, contents = 'fixture') {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
  return absolutePath;
}

/** A fresh temporary directory removed when the test finishes. */
function temporaryRoot(context, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

module.exports = {
  REPOSITORY_ROOT,
  temporaryRoot,
  writeFile,
};
