#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readText(rootDirectory, relativePath) {
  return fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8').replace(/^\uFEFF/, '');
}

function readJson(rootDirectory, relativePath) {
  try {
    return JSON.parse(readText(rootDirectory, relativePath));
  } catch (error) {
    throw new Error(`Could not parse ${relativePath}: ${error.message}`);
  }
}

function extractTomlSection(toml, sectionName) {
  const lines = toml.split(/\r?\n/);
  const sectionLines = [];
  let inRequestedSection = false;

  for (const line of lines) {
    const heading = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (heading) {
      inRequestedSection = heading[1].trim() === sectionName;
      continue;
    }

    if (inRequestedSection) {
      sectionLines.push(line);
    }
  }

  if (sectionLines.length === 0) {
    throw new Error(`Cargo.toml is missing [${sectionName}]`);
  }

  return sectionLines.join('\n');
}

function extractCargoWorkspaceVersion(toml) {
  const workspacePackage = extractTomlSection(toml, 'workspace.package');
  const match = workspacePackage.match(/^\s*version\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m);

  if (!match) {
    throw new Error('Cargo.toml [workspace.package] is missing a string version');
  }

  return match[1];
}

function assertDesktopUsesWorkspaceVersion(toml) {
  const packageSection = extractTomlSection(toml, 'package');
  if (!/^\s*version\.workspace\s*=\s*true\s*(?:#.*)?$/m.test(packageSection)) {
    throw new Error(
      'apps/desktop/src-tauri/Cargo.toml must inherit version.workspace instead of declaring another version',
    );
  }
}

function assertVersion(value, sourceName) {
  if (typeof value !== 'string' || !SEMVER_PATTERN.test(value)) {
    throw new Error(`${sourceName} has an invalid semantic version: ${JSON.stringify(value)}`);
  }
}

function assertAllVersionsMatch(versionSources) {
  for (const source of versionSources) {
    assertVersion(source.version, source.name);
  }

  const expectedVersion = versionSources[0].version;
  const mismatches = versionSources.filter((source) => source.version !== expectedVersion);

  if (mismatches.length > 0) {
    const details = versionSources.map((source) => `  - ${source.name}: ${source.version}`).join('\n');
    throw new Error(`Application versions are inconsistent:\n${details}`);
  }

  return expectedVersion;
}

function collectRepositoryVersions(rootDirectory = REPOSITORY_ROOT) {
  const rootPackage = readJson(rootDirectory, 'package.json');
  const rootLock = readJson(rootDirectory, 'package-lock.json');
  const desktopPackage = readJson(rootDirectory, 'apps/desktop/package.json');
  const desktopLock = readJson(rootDirectory, 'apps/desktop/package-lock.json');
  const tauriConfig = readJson(rootDirectory, 'apps/desktop/src-tauri/tauri.conf.json');
  const cargoWorkspace = readText(rootDirectory, 'Cargo.toml');
  const desktopCargo = readText(rootDirectory, 'apps/desktop/src-tauri/Cargo.toml');

  assertDesktopUsesWorkspaceVersion(desktopCargo);

  if (!rootLock.packages || !rootLock.packages['']) {
    throw new Error('package-lock.json is missing its root package record');
  }
  if (!desktopLock.packages || !desktopLock.packages['']) {
    throw new Error('apps/desktop/package-lock.json is missing its root package record');
  }

  const nodeVersion = readText(rootDirectory, '.node-version').trim();
  if (!SEMVER_PATTERN.test(nodeVersion)) {
    throw new Error(`.node-version must contain an exact semantic version, received ${JSON.stringify(nodeVersion)}`);
  }

  if (typeof desktopPackage.packageManager !== 'string' || !/^npm@\d+\.\d+\.\d+$/.test(desktopPackage.packageManager)) {
    throw new Error('apps/desktop/package.json must pin npm with an exact packageManager value');
  }

  return {
    nodeVersion,
    packageManager: desktopPackage.packageManager,
    versions: [
      { name: 'package.json', version: rootPackage.version },
      { name: 'package-lock.json', version: rootLock.version },
      { name: 'package-lock.json packages[""]', version: rootLock.packages[''].version },
      { name: 'Cargo.toml [workspace.package]', version: extractCargoWorkspaceVersion(cargoWorkspace) },
      { name: 'apps/desktop/package.json', version: desktopPackage.version },
      { name: 'apps/desktop/package-lock.json', version: desktopLock.version },
      {
        name: 'apps/desktop/package-lock.json packages[""]',
        version: desktopLock.packages[''].version,
      },
      { name: 'apps/desktop/src-tauri/tauri.conf.json', version: tauriConfig.version },
    ],
  };
}

function main() {
  const repository = collectRepositoryVersions();
  const version = assertAllVersionsMatch(repository.versions);

  console.log(`Version consistency passed: ${version}`);
  console.log(`Runtime pins: Node ${repository.nodeVersion}, ${repository.packageManager}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Version consistency failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  assertAllVersionsMatch,
  assertDesktopUsesWorkspaceVersion,
  collectRepositoryVersions,
  extractCargoWorkspaceVersion,
  extractTomlSection,
};
