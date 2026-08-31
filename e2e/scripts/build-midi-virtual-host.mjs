/* global Buffer, fetch */

import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

const PACKAGE = Object.freeze({
  name: 'Windows.Devices.Midi2.0.99.63-devpreview.6.nupkg',
  sha256: '2901642e241124f3444259f484f35aea7b320d67f176086acac0cf3cf1deefa9',
  url: 'https://github.com/microsoft/MIDI/releases/download/inbox-dev-preview-6/Windows.Devices.Midi2.0.99.63-devpreview.6.nupkg',
});

const ordinaryFile = (path) => {
  try {
    const status = lstatSync(path);
    return status.isFile() && !status.isSymbolicLink();
  } catch {
    return false;
  }
};

const hash = async (bytes) => createHash('sha256').update(bytes).digest('hex');

const ensurePackage = async (sourceRoot) => {
  const target = join(sourceRoot, PACKAGE.name);
  if (ordinaryFile(target)) {
    const bytes = await import('node:fs/promises').then(({ readFile }) => readFile(target));
    if (await hash(bytes) === PACKAGE.sha256) return target;
    throw new Error('the cached Windows MIDI SDK package digest is invalid');
  }
  const partial = `${target}.partial`;
  rmSync(partial, { force: true });
  const response = await fetch(PACKAGE.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`the Windows MIDI SDK download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (await hash(bytes) !== PACKAGE.sha256) {
    throw new Error('the downloaded Windows MIDI SDK package digest is invalid');
  }
  writeFileSync(partial, bytes, { flag: 'wx' });
  renameSync(partial, target);
  return target;
};

const xml = (value) => value
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

const localAppData = process.env.LOCALAPPDATA;
if (process.platform !== 'win32' || typeof localAppData !== 'string' || localAppData.length === 0) {
  throw new Error('the virtual MIDI host can only be built in a bounded Windows development cache');
}
const cache = join(localAppData, 'OSG-Development', 'cache', 'midi-e2e-toolchain');
const sourceRoot = join(cache, 'package-source');
const packages = join(cache, 'packages');
mkdirSync(sourceRoot, { recursive: true });
mkdirSync(packages, { recursive: true });
await ensurePackage(sourceRoot);

const configuredDotnet = process.env.OSG_E2E_DOTNET_10;
const cachedDotnet = join(localAppData, 'OSG-Development', 'cache', 'dotnet-sdk-10', 'dotnet.exe');
const dotnet = typeof configuredDotnet === 'string' && configuredDotnet.length > 0
  ? configuredDotnet
  : cachedDotnet;
if (!ordinaryFile(dotnet)) {
  throw new Error('the MIDI host requires a .NET 10 SDK (set OSG_E2E_DOTNET_10 to its dotnet.exe)');
}
const sdkList = execFileSync(dotnet, ['--list-sdks'], {
  encoding: 'utf8',
  timeout: 30_000,
  windowsHide: true,
});
if (!/^10\.\d+\.\d+\s/mu.test(sdkList)) throw new Error('the configured dotnet has no .NET 10 SDK');

const config = join(cache, 'NuGet.Config');
writeFileSync(config, `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="midi-sdk" value="${xml(sourceRoot)}" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />
  </packageSources>
</configuration>
`, { encoding: 'utf8' });

const project = resolve(import.meta.dirname, '..', 'tools', 'midi-virtual-host', 'midi-virtual-host.csproj');
const shared = { encoding: 'utf8', timeout: 5 * 60_000, windowsHide: true };
execFileSync(dotnet, [
  'restore',
  project,
  '--locked-mode',
  '--packages',
  packages,
  '--configfile',
  config,
], shared);
execFileSync(dotnet, [
  'build',
  project,
  '--no-restore',
  '--configuration',
  'Release',
  '--runtime',
  'win-x64',
  `--property:RestorePackagesPath=${packages}`,
], shared);

const host = join(
  resolve(project, '..'),
  'bin',
  'Release',
  'net10.0-windows10.0.26100.0',
  'win-x64',
  'midi-virtual-host.exe',
);
if (!ordinaryFile(host) || basename(host) !== 'midi-virtual-host.exe') {
  throw new Error('the MIDI host build published no reviewed executable');
}
process.stdout.write(`${host}\n`);
