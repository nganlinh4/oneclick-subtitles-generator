'use strict';

const { spawnSync } = require('node:child_process');
const process = require('node:process');

const WINDOWS_PROCESS_CREATION_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u;
const cachedIdentities = new Map();

const readWindowsProcessIdentity = ({
  processId,
  spawn = spawnSync,
  useCache = spawn === spawnSync,
} = {}) => {
  if (process.platform !== 'win32') {
    throw new Error('managed process identity is available on Windows only');
  }
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new Error('managed process identity requires a positive integer process id');
  }
  // Only this still-running Node process can safely cache its own creation identity. An external
  // lease owner may exit and have its PID reused while this verifier remains alive.
  const mayCache = useCache && processId === process.pid;
  if (mayCache && cachedIdentities.has(processId)) return cachedIdentities.get(processId);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$records = @(Get-CimInstance Win32_Process -Filter 'ProcessId = ${processId}' -ErrorAction Stop)`,
    "if ($records.Count -ne 1) { throw 'managed process is missing or ambiguous' }",
    "$created = ([DateTime]$records[0].CreationDate).ToUniversalTime().ToString('O')",
    '$created',
  ].join('; ');
  const result = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
    maxBuffer: 16 * 1024,
  });
  if (result.error) throw result.error;
  const processCreatedUtc = String(result.stdout ?? '').trim();
  if (result.status !== 0 || !WINDOWS_PROCESS_CREATION_PATTERN.test(processCreatedUtc)) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(
      `could not verify managed process ${processId} creation identity${detail ? `: ${detail}` : ''}`,
    );
  }
  const identity = Object.freeze({ processId, processCreatedUtc });
  if (mayCache) cachedIdentities.set(processId, identity);
  return identity;
};

const assertWindowsProcessIdentity = ({ processId, processCreatedUtc }, options = {}) => {
  if (!WINDOWS_PROCESS_CREATION_PATTERN.test(processCreatedUtc ?? '')) {
    throw new Error('managed process creation identity has an invalid canonical timestamp');
  }
  const live = readWindowsProcessIdentity({ processId, ...options });
  if (live.processCreatedUtc !== processCreatedUtc) {
    throw new Error('managed process id was reused or its creation identity changed');
  }
  return live;
};

const readCurrentWindowsProcessIdentity = (options = {}) => readWindowsProcessIdentity({
  processId: process.pid,
  ...options,
});

module.exports = {
  WINDOWS_PROCESS_CREATION_PATTERN,
  assertWindowsProcessIdentity,
  readCurrentWindowsProcessIdentity,
  readWindowsProcessIdentity,
};
