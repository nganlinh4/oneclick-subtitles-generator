// Where a journey runs, and what it is allowed to touch.
//
// Every run gets its own data root. That is not tidiness: the application resolves its data
// directory through SHGetKnownFolderPath, so a run without an explicit root writes into the
// developer's real projects — 17 of them on the machine this was written on. The root is passed
// through OSG_E2E_DATA_ROOT, which exists only in the `unsigned-local-build` channel.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');

/** The binary under test. The E2E channel, never a production build. */
export const APPLICATION_BINARY = join(
  REPOSITORY_ROOT,
  'target', 'x86_64-pc-windows-msvc', 'release', 'osg-desktop.exe',
);

/** A fresh, isolated root for one run. Returned so the caller can also collect evidence from it. */
export const createRunRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-e2e-'));
  for (const child of ['data', 'cache', 'logs', 'evidence', 'output']) {
    mkdirSync(join(root, child), { recursive: true });
  }
  return root;
};

export const removeRunRoot = (root) => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A locked log file is not a test failure; the temporary directory is disposable either way.
  }
};
