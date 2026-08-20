// Where a journey runs, and what it is allowed to touch.
//
// Every run gets its own data root. That is not tidiness: the application resolves its data
// directory through SHGetKnownFolderPath, so a run without an explicit root writes into the
// developer's real projects — 17 of them on the machine this was written on. The root is passed
// through OSG_E2E_DATA_ROOT, which exists only in the `unsigned-local-build` channel.

import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * Reviewed SUBTITLE fixtures a journey may hand to the application.
 *
 * Subtitle files only. There are no media fixtures any more: a journey that wants video downloads a
 * real one from a real URL, because a synthetic colour-bars clip proved the decoder could open a
 * synthetic colour-bars clip and nothing about what a customer actually plays. See `realMedia.js`.
 */
export const FIXTURE_ROOT = join(REPOSITORY_ROOT, 'e2e', 'fixtures', 'subtitles');

/**
 * Where the optional native tools live BETWEEN runs.
 *
 * FFmpeg, yt-dlp and Deno are downloaded from the reviewed delivery catalog on first use, and FFmpeg
 * alone is 110 MB. A customer installs them once and keeps them; re-downloading them for every
 * journey would be testing the installer over and over instead of testing the workflow, and would
 * put a third of a gigabyte of network traffic between a code change and its answer.
 *
 * So the directory is real, persistent, and OUTSIDE the disposable run root — junctioned in, rather
 * than provided by a new environment variable, because the application must keep resolving its tools
 * exactly where it resolves them for a customer. `nativeToolsInstall.journey.js` is the one that
 * starts from empty and proves the install itself.
 */
export const NATIVE_TOOLS_CACHE = join(REPOSITORY_ROOT, 'target', 'e2e-native-tools');

/**
 * Where a real downloaded video is kept between runs. This cache is input-only; every journey
 * copies its selected media into its disposable run root and writes exports elsewhere in that root.
 *
 * Created eagerly, because the application CANONICALIZES this root before it will honour a staged
 * destination — and canonicalizing a directory that does not exist fails, which makes the seam fall
 * back to the real dialog. Measured: a run with this directory missing opened a native save dialog
 * behind the application window and hung for fifteen minutes with no error and no file.
 */
export const REAL_MEDIA_CACHE = join(REPOSITORY_ROOT, 'target', 'e2e-real-media');
mkdirSync(REAL_MEDIA_CACHE, { recursive: true });

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
 *
 * `keepNativeTools` junctions the persistent tool directory in. Everything else about the root stays
 * disposable: the database, the projects, the caches and the logs are all new every run.
 */
export const createRunRoot = ({ keepNativeTools = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'osg-e2e-'));
  for (const child of ['data', 'cache', 'logs', 'webview', 'evidence', 'input', 'output']) {
    mkdirSync(join(root, child), { recursive: true });
  }
  if (keepNativeTools) {
    mkdirSync(NATIVE_TOOLS_CACHE, { recursive: true });
    // A junction rather than a copy: the application writes its install receipts here, and they have
    // to survive the run that wrote them for the next run to see the tools as installed.
    symlinkSync(NATIVE_TOOLS_CACHE, join(root, 'data', 'native-tools'), 'junction');
  }
  return root;
};

export const stagedDialogPaths = (root, cachedVideo) => Object.freeze({
  fixtureRoot: root,
  mediaSelection: cachedVideo === null ? null : join(root, 'input', basename(cachedVideo)),
  mediaDestination: join(root, 'output'),
});

/** Everything a run must set so it cannot reach live user state. */
export const isolationEnvironment = (root) => ({
  OSG_E2E_DATA_ROOT: root,
  // The only files a staged file-dialog selection may name. The application resolves and re-checks
  // this itself; declaring it here is what keeps a journey to reviewed files.
  OSG_E2E_FIXTURE_ROOT: process.env.OSG_E2E_FIXTURE_ROOT ?? root,
  // What the next OPEN dialog returns, and where the next SAVE dialog writes. Both are read from
  // the process environment, so they are fixed for a launch; a journey needing different ones runs
  // its own launch. Both are bounded by the application to the reviewed root above.
  ...(process.env.OSG_E2E_MEDIA_SELECTION === undefined
    ? {}
    : { OSG_E2E_MEDIA_SELECTION: process.env.OSG_E2E_MEDIA_SELECTION }),
  ...(process.env.OSG_E2E_MEDIA_DESTINATION === undefined
    ? {}
    : { OSG_E2E_MEDIA_DESTINATION: process.env.OSG_E2E_MEDIA_DESTINATION }),
  WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
});

export const removeRunRoot = (root) => {
  try {
    // The junction is removed, never followed: `rm -r` through a junction would delete the tools
    // every run and quietly reinstate the 110 MB download this cache exists to avoid.
    rmSync(join(root, 'data', 'native-tools'), { recursive: false, force: true });
  } catch {
    // Absent when the run did not junction it in.
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A locked log file is not a test failure; the temporary directory is disposable either way.
  }
};
