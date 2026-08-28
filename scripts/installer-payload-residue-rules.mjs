/**
 * Forbidden-residue catalog for the built Windows NSIS payload.
 *
 * CLAUDE.md states: "The former Electron, Express, Flask, FastAPI, fixed-port, CORS, and
 * browser-owned process stack has been removed. Do not recreate it or add browser fallbacks for
 * native operations." `ARCHITECTURE.md:25` repeats the same list. This module turns that sentence
 * into exact file/directory fingerprints so a packaged installer can be checked mechanically rather
 * than by re-reading prose.
 *
 * Every rule below is provenanced in its own comment: either a path this repository's own git
 * history shows was deleted (`git log --diff-filter=D --name-only -- .` on `main`, the pre-rewrite
 * Electron/Express/Flask branch), or a name that is a load-bearing, publicly documented artifact of
 * the exact removed technology (electron-builder's NSIS layout, CEF/Chromium's Windows payload,
 * CPython's Windows embeddable layout, Node's own executable names). None of these collide with
 * anything the reviewed payload actually ships: the shipped set is exactly one `osg-desktop.exe`,
 * `ui-fonts/<sha256>`, `workers/*.py` (worker *source*, not an interpreter), and
 * `licenses/{LICENSE,THIRD_PARTY_NOTICES.md}` (`apps/desktop/src-tauri/tauri.conf.json` bundle
 * resources; confirmed empirically against a real published application directory under
 * `%LOCALAPPDATA%\OSG-Development\cache\apps\e2e\applications\<digest>\`). In particular this
 * catalog never forbids `*.dll` in general: Tauri's own NSIS bootstrap
 * (`scripts/prepare-tauri-nsis.ps1`) legitimately carries `nsis_tauri_utils.dll` as installer
 * *authoring* machinery, and that is not application payload residue.
 */

/** @typedef {{ id: string, description: string, provenance: string, test: (relPosix: string, base: string) => boolean }} ResidueRule */

const lower = (value) => value.toLowerCase();

/** Exact (case-insensitive) file or directory basenames that must never appear anywhere in the payload. */
const FORBIDDEN_BASENAMES = Object.freeze([
  // --- Electron: `electron/main.js`, `electron/main-simple.js`, `electron/preload.js`, and the
  // dedicated `.github/workflows/build-electron.yml` all existed on `main` before the rewrite and
  // were deleted. electron-builder's own NSIS target always ships these exact names.
  ['electron.exe', 'the removed Electron shell (git-deleted electron/main.js, electron/preload.js)'],
  ['licenses.chromium.html', 'electron-builder auto-generated Chromium notice file'],
  ['license.electron.txt', 'electron-builder auto-generated Electron notice file'],
  ['update.exe', 'Squirrel.Windows updater electron-builder installs beside the app'],
  ['squirrel.exe', 'Squirrel.Windows updater electron-builder installs beside the app'],
  // --- Chrome/Chromium/CEF: the exact Windows payload files a Chromium Embedded Framework or
  // electron-builder NSIS build always contains next to the main executable.
  ['chrome.exe', 'a bundled Chromium/CEF browser process'],
  ['chromedriver.exe', 'a bundled Chromium WebDriver binary'],
  ['msedgewebview2.exe', 'a bundled (rather than OS-evergreen) WebView2 runtime process'],
  ['resources.pak', 'Chromium/CEF packed resources'],
  ['icudtl.dat', "Chromium's ICU data table"],
  ['snapshot_blob.bin', "V8's startup snapshot, part of a bundled Chromium/Node runtime"],
  ['v8_context_snapshot.bin', "V8's context snapshot, part of a bundled Chromium/Node runtime"],
  ['vk_swiftshader.dll', "Chromium's software Vulkan renderer"],
  ['libegl.dll', 'a bundled Chromium/ANGLE GL implementation'],
  ['libglesv2.dll', 'a bundled Chromium/ANGLE GL implementation'],
  ['d3dcompiler_47.dll', "Chromium's D3D shader compiler redistributable"],
  ['libcef.dll', 'the Chromium Embedded Framework runtime'],
  // --- Node: the desktop app is a Rust/Tauri binary, not a Node host. `tauri.conf.json` declares no
  // `bundle.externalBin` sidecar, so nothing should ever place a Node executable in the payload.
  ['node.exe', 'a bundled Node.js runtime executable'],
  ['npm.cmd', 'a bundled Node package-manager shim'],
  ['npx.cmd', 'a bundled Node package-runner shim'],
  // --- Python interpreter: `workers/osg_asr_worker.py` and `workers/osg_speech_worker.py` are
  // worker *source* the config declares (`tauri.conf.json` bundle.resources); the interpreter that
  // runs them is a separate, content-addressed runtime delivery per CLAUDE.md ("Optional tools and
  // model runtimes come only from reviewed, target-specific, content-addressed delivery catalogs")
  // and THIRD_PARTY_NOTICES.md's CPython entry, never something the installer itself carries.
  ['python.exe', 'a bundled CPython interpreter'],
  ['pythonw.exe', 'a bundled CPython interpreter'],
  ['python3.exe', 'a bundled CPython interpreter'],
  ['pip.exe', 'a bundled Python package manager'],
  // --- Server stack: `server.js`, the `server/` tree (server/modelManager.py,
  // server/narrationService.py, server/requirements.txt, server/routes/*.js), and the root `app.js`
  // Express entry point were all git-deleted from `main`. `chatterbox-fastapi/` (api.py,
  // requirements-api.txt, start_api.py, Dockerfile) was the removed FastAPI voice-cloning service.
  ['server.js', 'the removed Express server entry point (git-deleted server.js)'],
  ['app.js', 'the removed root Express entry point (git-deleted app.js)'],
  ['requirements.txt', 'a removed Flask/FastAPI Python service manifest (git-deleted server/requirements.txt, chatterbox-fastapi/requirements-api.txt)'],
  ['requirements-api.txt', 'the removed chatterbox-fastapi service manifest'],
]);

/** Directory names that must never appear anywhere in the payload, regardless of depth. */
const FORBIDDEN_DIRECTORY_NAMES = Object.freeze([
  ['electron', 'the removed electron/ source tree (git-deleted electron/main.js, electron/preload.js)'],
  ['server', 'the removed server/ Express+Flask tree (git-deleted server/modelManager.py, server/narrationService.py, server/routes/*)'],
  ['chatterbox-fastapi', 'the removed FastAPI voice-cloning service (git-deleted chatterbox-fastapi/api.py)'],
  ['chatterbox', 'the removed Chatterbox TTS Python package tree'],
  ['node_modules', 'a bundled Node dependency tree; workers ship as source, never as an installed npm tree'],
  ['site-packages', 'a bundled Python interpreter environment'],
  ['__pycache__', 'compiled Python bytecode from a bundled interpreter run'],
  ['swiftshader', "Chromium's bundled software renderer directory"],
  ['locales', "Chromium/Electron's per-locale .pak resource directory"],
  ['app.asar.unpacked', "electron-builder's unpacked native-module directory"],
]);

/** Pattern rules for names that vary (a hash, a version) but whose shape is still a fingerprint. */
const FORBIDDEN_PATTERNS = Object.freeze([
  [/^chrome_(?:100|200)_percent\.pak$/i, 'a Chromium DPI-scaled resource pack'],
  [/^ffmpeg\.dll$/i, "Electron's own bundled FFmpeg shim (distinct from the FFmpeg the app downloads separately)"],
  [/^python3?\d{1,3}\.dll$/i, 'a bundled CPython shared runtime library'],
  [/\.node$/i, 'a bundled Node native addon binary'],
  [/\.asar(?:\.unpacked)?$/i, "an electron-builder packed application archive"],
]);

function toPosix(relativePath) {
  return relativePath.split('\\').join('/');
}

/**
 * @param {{ relativePath: string }[]} entries payload files, relative to the extraction/payload root
 * @returns {{ path: string, rule: string, reason: string }[]} every match, in file order
 */
export function scanForbiddenResidue(entries) {
  const violations = [];
  for (const entry of entries) {
    const relPosix = toPosix(entry.relativePath);
    const segments = relPosix.split('/').filter(Boolean);
    const base = lower(segments.at(-1) ?? '');

    for (const [name, reason] of FORBIDDEN_BASENAMES) {
      if (base === name) {
        violations.push({ path: relPosix, rule: `basename:${name}`, reason });
      }
    }
    for (const [name, reason] of FORBIDDEN_DIRECTORY_NAMES) {
      if (segments.slice(0, -1).some((segment) => lower(segment) === name)) {
        violations.push({ path: relPosix, rule: `directory:${name}`, reason });
      }
    }
    for (const [pattern, reason] of FORBIDDEN_PATTERNS) {
      if (pattern.test(base)) {
        violations.push({ path: relPosix, rule: `pattern:${pattern.source}`, reason });
      }
    }
  }
  return violations;
}

export const RESIDUE_RULE_COUNT =
  FORBIDDEN_BASENAMES.length + FORBIDDEN_DIRECTORY_NAMES.length + FORBIDDEN_PATTERNS.length;
