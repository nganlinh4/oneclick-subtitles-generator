import { spawnSync } from 'node:child_process';
import process from 'node:process';

/**
 * Read-only Windows PE version-resource metadata (`FileVersion`, `ProductVersion`,
 * `ProductName`, ...). No existing script in this repository parses `VS_VERSIONINFO` directly, so
 * this reuses the same dependency-injected `pwsh` pattern as
 * `scripts/windows-process-identity.js` (`spawn = spawnSync`, so tests can inject a fake process)
 * rather than hand-rolling a PE resource-section parser.
 *
 * `Get-Item ... | Select-Object VersionInfo` reads the file's resource table through .NET's
 * `FileVersionInfo` — it never loads the executable's code and never runs it, so this satisfies the
 * "never execute an installer" rule while still inspecting the exact bytes Windows itself would show
 * in Explorer's Details tab.
 */

const FIELDS = Object.freeze([
  'FileVersion',
  'ProductVersion',
  'ProductName',
  'CompanyName',
  'FileDescription',
  'InternalName',
  'OriginalFilename',
  'LegalCopyright',
]);

function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function readWindowsExecutableVersionInfo(executablePath, { spawn = spawnSync } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Windows PE version-metadata reads are available on Windows only');
  }
  if (typeof executablePath !== 'string' || executablePath.trim() === '') {
    throw new Error('Windows PE version-metadata read requires a non-empty executable path');
  }
  const projection = FIELDS.map((field) => `'${field}'=$info.${field}`).join(';');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$item = Get-Item -LiteralPath ${quotePowerShellLiteral(executablePath)} -ErrorAction Stop`,
    'if ($item.PSIsContainer) { throw "not a file" }',
    '$info = $item.VersionInfo',
    `[ordered]@{${projection}} | ConvertTo-Json -Compress`,
  ].join('; ');

  const result = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error) {
    throw new Error(`Could not read Windows executable metadata: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? '').trim();
    throw new Error(`Could not read Windows executable metadata for ${executablePath}${detail ? `: ${detail}` : ''}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? '').trim());
  } catch (error) {
    throw new Error(`Windows executable metadata was not valid JSON: ${error.message}`);
  }
  const metadata = {};
  for (const field of FIELDS) {
    metadata[field] = typeof parsed[field] === 'string' ? parsed[field] : null;
  }
  return Object.freeze(metadata);
}

/**
 * PE `FileVersion`/`ProductVersion` are conventionally four dot-separated integers
 * (`MAJOR.MINOR.PATCH.BUILD`); this repository's semantic version
 * (`scripts/check-version-consistency.js`) is three (`MAJOR.MINOR.PATCH`). Tauri/NSIS pad with a
 * trailing build component, so the comparison only requires the first three components to match.
 */
export function windowsVersionMatchesSemver(windowsVersion, semver) {
  if (typeof windowsVersion !== 'string' || typeof semver !== 'string') {
    return false;
  }
  const windowsParts = windowsVersion.trim().split('.');
  const semverParts = semver.trim().split(/[.-]/).slice(0, 3);
  if (windowsParts.length < 3 || semverParts.length !== 3) {
    return false;
  }
  return semverParts.every((part, index) => windowsParts[index] === part);
}
