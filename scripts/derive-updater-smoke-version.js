#!/usr/bin/env node

const fs = require('node:fs');

const {
  assertAllVersionsMatch,
  collectRepositoryVersions,
} = require('./check-version-consistency');

const MAX_WINDOWS_VERSION_COMPONENT = 65_535n;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseWindowsSafeSemVer(value, label = 'Version') {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a semantic-version string`);
  }
  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    throw new Error(`${label} is not a valid semantic version: ${JSON.stringify(value)}`);
  }

  const core = match.slice(1, 4).map((component) => BigInt(component));
  if (core.some((component) => component > MAX_WINDOWS_VERSION_COMPONENT)) {
    throw new Error(
      `${label} exceeds the Windows NSIS component limit of ${MAX_WINDOWS_VERSION_COMPONENT}`,
    );
  }
  const build = match[5] === undefined ? null : match[5];
  if (/^\d+$/.test(build ?? '') && BigInt(build) > MAX_WINDOWS_VERSION_COMPONENT) {
    throw new Error(
      `${label} has numeric build metadata above the Windows NSIS component limit of ${MAX_WINDOWS_VERSION_COMPONENT}`,
    );
  }

  return Object.freeze({
    value,
    major: core[0],
    minor: core[1],
    patch: core[2],
    prerelease: match[4] === undefined ? null : Object.freeze(match[4].split('.')),
    build,
  });
}

function comparePrereleaseIdentifiers(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;

    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      return BigInt(left[index]) < BigInt(right[index]) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function compareSemVer(leftValue, rightValue) {
  const left = parseWindowsSafeSemVer(leftValue, 'Left version');
  const right = parseWindowsSafeSemVer(rightValue, 'Right version');
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

function deriveUpdaterSmokeVersion(baseVersion) {
  const base = parseWindowsSafeSemVer(baseVersion, 'Base application version');
  let { major, minor, patch } = base;

  if (base.prerelease === null) {
    if (patch < MAX_WINDOWS_VERSION_COMPONENT) {
      patch += 1n;
    } else if (minor < MAX_WINDOWS_VERSION_COMPONENT) {
      minor += 1n;
      patch = 0n;
    } else if (major < MAX_WINDOWS_VERSION_COMPONENT) {
      major += 1n;
      minor = 0n;
      patch = 0n;
    } else {
      throw new Error('Base application version exhausts the Windows NSIS version space');
    }
  }

  const updatedVersion = `${major}.${minor}.${patch}`;
  if (compareSemVer(updatedVersion, baseVersion) <= 0) {
    throw new Error('Derived updater smoke version is not greater than the base version');
  }
  return updatedVersion;
}

function assertUpdaterVersionPair(baseVersion, updatedVersion) {
  parseWindowsSafeSemVer(baseVersion, 'Base updater version');
  parseWindowsSafeSemVer(updatedVersion, 'Updated updater version');
  if (compareSemVer(updatedVersion, baseVersion) <= 0) {
    throw new Error('Updated updater version must be greater than the base updater version');
  }
  return Object.freeze({ baseVersion, updatedVersion });
}

function collectUpdaterVersionContract(rootDirectory) {
  const repository = collectRepositoryVersions(rootDirectory);
  const baseVersion = assertAllVersionsMatch(repository.versions);
  const updatedVersion = deriveUpdaterSmokeVersion(baseVersion);
  assertUpdaterVersionPair(baseVersion, updatedVersion);
  return Object.freeze({ baseVersion, updatedVersion });
}

function assertRepositoryVersionContract(baseVersion, updatedVersion, rootDirectory) {
  const expected = collectUpdaterVersionContract(rootDirectory);
  assertUpdaterVersionPair(baseVersion, updatedVersion);
  if (baseVersion !== expected.baseVersion || updatedVersion !== expected.updatedVersion) {
    throw new Error(
      `Updater smoke version contract mismatch: expected ${expected.baseVersion} -> ${expected.updatedVersion}`,
    );
  }
  return expected;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 2 && argv[0] === '--github-output') {
    const contract = collectUpdaterVersionContract();
    fs.appendFileSync(
      argv[1],
      `base=${contract.baseVersion}\nupdated=${contract.updatedVersion}\n`,
      'utf8',
    );
    console.log(`Updater smoke version contract: ${contract.baseVersion} -> ${contract.updatedVersion}`);
    return;
  }
  if (argv.length === 3 && argv[0] === '--assert-contract') {
    const contract = assertRepositoryVersionContract(argv[1], argv[2]);
    console.log(`Updater smoke version contract verified: ${contract.baseVersion} -> ${contract.updatedVersion}`);
    return;
  }
  throw new Error(
    'Usage: derive-updater-smoke-version.js --github-output PATH | --assert-contract BASE UPDATED',
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Updater smoke version derivation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  MAX_WINDOWS_VERSION_COMPONENT,
  assertRepositoryVersionContract,
  assertUpdaterVersionPair,
  collectUpdaterVersionContract,
  compareSemVer,
  deriveUpdaterSmokeVersion,
  main,
  parseWindowsSafeSemVer,
};
