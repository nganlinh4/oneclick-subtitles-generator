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

/** Reviewed media fixtures a journey may hand to the application. */
export const FIXTURE_ROOT = join(REPOSITORY_ROOT, 'e2e', 'fixtures', 'media');

/** Where the E2E channel binary and its resources are built. */
export const BUILT_APPLICATION_DIRECTORY = join(
  REPOSITORY_ROOT, 'target', 'x86_64-pc-windows-msvc', 'release',
);

/**
 * The binary under test. The E2E channel, never a production build.
 *
 * `OSG_E2E_BINARY` points the harness at a STAGED copy instead. That exists so a journey can damage
 * what the application ships -- a corrupt font resource, a missing one -- without touching the build
 * output every other journey depends on. The staged copy is a real installation layout, so the
 * application resolves its resources exactly as it does in the built one.
 */
export const APPLICATION_BINARY = process.env.OSG_E2E_BINARY
  ?? join(BUILT_APPLICATION_DIRECTORY, 'osg-desktop.exe');

/**
 * A fresh, isolated root for one run, including the WebView2 profile.
 *
 * `OSG_E2E_DATA_ROOT` moves the database, cache and logs. It does NOT move WebView2's own profile,
 * which holds `localStorage` — and that is where this application keeps its recent-videos list and
 * its subtitle settings. Measured: eight "isolated" runs left no `EBWebView` directory in their
 * roots, and a run in a supposedly clean root displayed the developer's real recent YouTube videos.
 * Those runs were reading, and could have written, live user state.
 *
 * `WEBVIEW2_USER_DATA_FOLDER` is honoured here: setting it produced a `webview` directory inside the
 * isolated root while the live profile's modification time did not change.
 */
export const createRunRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-e2e-'));
  for (const child of ['data', 'cache', 'logs', 'webview', 'evidence', 'output']) {
    mkdirSync(join(root, child), { recursive: true });
  }
  return root;
};

/** Everything a run must set so it cannot reach live user state. */
export const isolationEnvironment = (root) => ({
  OSG_E2E_DATA_ROOT: root,
  // The only files a staged file-dialog selection may name. The application resolves and re-checks
  // this itself; declaring it here is what keeps a journey to reviewed fixtures.
  OSG_E2E_FIXTURE_ROOT: FIXTURE_ROOT,
  // What the next file-dialog request returns. Read from the process environment, so it is fixed for
  // a launch; a journey needing a different file runs its own launch.
  OSG_E2E_MEDIA_SELECTION: process.env.OSG_E2E_MEDIA_SELECTION
    ?? join(FIXTURE_ROOT, 'bars-6s-640x360.mp4'),
  WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
});

export const removeRunRoot = (root) => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A locked log file is not a test failure; the temporary directory is disposable either way.
  }
};
