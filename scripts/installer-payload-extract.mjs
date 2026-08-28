import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Locate-and-extract helpers for inspecting a built NSIS installer without ever running it.
 *
 * `scripts/check-release-artifacts.js` already does exactly this (`sevenZipExecutable`,
 * `extractWithSevenZip`, the nested-`.7z` handling inside `inspectNsisPackage`) but does not export
 * those internals, and it is already at the file-size guideline ceiling, so this module holds a
 * small, independently testable copy rather than growing that file. Both use the same locked
 * dependency, `7zip-bin-full` (see `apps/desktop's release CI and `package.json`'s
 * `"7zip-bin-full": "26.2.1"` devDependency), so extraction behavior stays identical.
 */

const nodeRequire = createRequire(import.meta.url);

/** @returns {{ executable: string, source: '7zip-bin-full' | 'system PATH' } | null} */
export function locateSevenZip({ probe = spawnSync, requireLockedPackage = nodeRequire } = {}) {
  try {
    // eslint-disable-next-line import/no-dynamic-require -- optional dependency probed at runtime
    const { path7z } = requireLockedPackage('7zip-bin-full');
    if (typeof path7z === 'string' && fs.existsSync(path7z)) {
      return { executable: path7z, source: '7zip-bin-full' };
    }
  } catch {
    // The locked package is not installed in this workspace; fall through to a system search.
  }
  for (const name of process.platform === 'win32' ? ['7z.exe', '7z'] : ['7z', '7za']) {
    const result = probe(name, ['i'], { encoding: 'utf8', windowsHide: true });
    if (!result.error && result.status === 0) {
      return { executable: name, source: 'system PATH' };
    }
  }
  return null;
}

export function sevenZipAvailability(options = {}) {
  const located = locateSevenZip(options);
  return {
    available: located !== null,
    executable: located?.executable ?? null,
    source: located?.source ?? null,
  };
}

function runSevenZip(executable, arguments_, label, { spawn = spawnSync } = {}) {
  const result = spawn(executable, arguments_, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Could not run ${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${String(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

export function extractWithSevenZip(executable, archivePath, destination, options = {}) {
  fs.mkdirSync(destination, { recursive: true });
  runSevenZip(
    executable,
    ['x', '-bd', '-y', `-o${destination}`, archivePath],
    `7-Zip extraction of ${path.basename(archivePath)}`,
    options,
  );
}

/** Every regular file below `directory`, recursing through subdirectories and never following symlinks. */
export function walkFiles(directory) {
  const results = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) results.push(entryPath);
    }
  };
  visit(directory);
  return results;
}

const MAX_NESTED_ARCHIVES = 16;

/**
 * Extract a built NSIS `.exe` into a private temporary directory using 7-Zip, including any nested
 * `.7z` application archive the NSIS script carries. Never launches the installer itself. The caller
 * owns cleanup of the returned directory.
 */
export function extractNsisInstallerPayload(installerPath, {
  extract = extractWithSevenZip,
  locate = locateSevenZip,
  tmpRoot = os.tmpdir(),
} = {}) {
  if (typeof installerPath !== 'string' || !fs.existsSync(installerPath)) {
    throw new Error(`NSIS installer does not exist: ${installerPath}`);
  }
  const located = locate();
  if (!located) {
    throw new Error(
      'No 7-Zip executable is available to extract the NSIS installer without running it. Install '
      + 'the locked `7zip-bin-full` npm dependency (run `npm install` at the repository root). '
      + 'Alternatively, a human operator can silently run the installer once in a disposable sandbox '
      + '(`installer.exe /S /D=<empty-directory>`) -- this DOES execute the installer, so only do it '
      + 'in an isolated, throwaway VM or container, never launch the app it installs, and never '
      + 'automate that step from this tool -- then pass the resulting directory with --payload-dir '
      + 'instead of --installer.',
    );
  }
  const extractionRoot = fs.mkdtempSync(path.join(tmpRoot, 'osg-installer-payload-inspection-'));
  try {
    extract(located.executable, installerPath, extractionRoot);
    const nestedArchives = walkFiles(extractionRoot).filter((file) => file.toLowerCase().endsWith('.7z'));
    if (nestedArchives.length > MAX_NESTED_ARCHIVES) {
      throw new Error(`NSIS package contains too many nested application archives: ${nestedArchives.length}`);
    }
    nestedArchives.forEach((archive, index) => {
      extract(located.executable, archive, path.join(extractionRoot, `.osg-nested-${index}`));
    });
    return extractionRoot;
  } catch (error) {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
    throw error;
  }
}
