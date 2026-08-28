import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Bounded resource sampling for the long-media soak journey: the desktop process's own working
 * set/private bytes/handle/thread counts, and the isolated run root's own file count and SQLite
 * footprint.
 *
 * WHY POWERSHELL Get-Process. This mirrors the codebase's existing Windows process-inspection
 * pattern (twoProcessScenario.js's `webviewProfileBusy`, scripts/windows-process-identity.js): a
 * short, non-interactive PowerShell command reading .NET Process properties. The process id never
 * flows into the script text -- it is handed over as an environment variable, exactly like
 * `webviewProfileBusy` hands over its profile path, so nothing here interpolates a value into a
 * shell command string.
 */

const REQUIRED_SAMPLE_KEYS = ['workingSetBytes', 'privateBytes', 'handleCount', 'threadCount'];

/** Read the live desktop application process's own working set, private bytes, handles and threads. */
export const sampleApplicationProcess = (processId) => {
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new Error('process sampling requires a positive integer process id');
  }
  const output = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = \'Stop\'; '
    + '$p = Get-Process -Id ([int]$env:OSG_E2E_SAMPLE_PROCESS_ID); '
    + '[PSCustomObject]@{ '
    + 'workingSetBytes = [int64]$p.WorkingSet64; '
    + 'privateBytes = [int64]$p.PrivateMemorySize64; '
    + 'handleCount = [int]$p.HandleCount; '
    + 'threadCount = [int]$p.Threads.Count '
    + '} | ConvertTo-Json -Compress',
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, OSG_E2E_SAMPLE_PROCESS_ID: String(processId) },
  });
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`process sample returned non-JSON output: ${output}`, { cause: error });
  }
  for (const key of REQUIRED_SAMPLE_KEYS) {
    if (!Number.isSafeInteger(parsed?.[key]) || parsed[key] < 0) {
      throw new Error(`process sample is missing or invalid ${key}: ${JSON.stringify(parsed)}`);
    }
  }
  return Object.freeze({
    workingSetBytes: parsed.workingSetBytes,
    privateBytes: parsed.privateBytes,
    handleCount: parsed.handleCount,
    threadCount: parsed.threadCount,
  });
};

// The isolated run root's own junctioned tool/engine caches are shared, persistent, and outside the
// disposable-per-run contract this census exists to check; native-tools alone is ~110MB and would
// swamp any bounded-growth delta with bytes this session never wrote.
const SKIPPED_TOP_LEVEL_DATA_CHILDREN = new Set(['native-tools', 'engine-packages']);

const walkRegularFiles = (root, { skipTopLevelNames = new Set() } = {}) => {
  if (!existsSync(root)) return [];
  const files = [];
  const pending = [{ path: root, depth: 0 }];
  while (pending.length > 0) {
    const { path: directory, depth } = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (depth === 0 && skipTopLevelNames.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      // A junction/reparse point is never walked: this census counts only what THIS session wrote.
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) pending.push({ path, depth: depth + 1 });
      else if (metadata.isFile()) files.push({ path, bytes: metadata.size });
    }
  }
  return files;
};

/**
 * Count and size every regular file this run owns under its data/cache trees, excluding the shared
 * persistent tool/engine caches. Used to prove no orphan scratch/temp file survives a heavy session.
 */
export const runRootFileCensus = (root) => {
  const dataFiles = walkRegularFiles(join(root, 'data'), {
    skipTopLevelNames: SKIPPED_TOP_LEVEL_DATA_CHILDREN,
  });
  const cacheFiles = walkRegularFiles(join(root, 'cache'));
  const all = [...dataFiles, ...cacheFiles];
  return Object.freeze({
    fileCount: all.length,
    totalBytes: all.reduce((sum, { bytes }) => sum + bytes, 0),
    paths: Object.freeze(all.map(({ path }) => path).sort()),
  });
};

/** The database's on-disk footprint, including its WAL/SHM sidecars while a checkpoint is pending. */
export const databaseFootprintBytes = (root) => {
  const dbDirectory = join(root, 'data', 'db');
  if (!existsSync(dbDirectory)) return 0;
  return ['osg.sqlite3', 'osg.sqlite3-wal', 'osg.sqlite3-shm']
    .map((name) => join(dbDirectory, name))
    .filter((path) => existsSync(path))
    .reduce((sum, path) => sum + statSync(path).size, 0);
};
