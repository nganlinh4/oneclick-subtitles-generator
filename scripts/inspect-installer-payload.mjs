import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractNsisInstallerPayload, sevenZipAvailability, walkFiles } from './installer-payload-extract.mjs';
import { scanForbiddenResidue } from './installer-payload-residue-rules.mjs';
import {
  readWindowsExecutableVersionInfo,
  windowsVersionMatchesSemver,
} from './read-windows-executable-metadata.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const TARGET = 'x86_64-pc-windows-msvc';
const TAURI_CONFIG_RELATIVE = 'apps/desktop/src-tauri/tauri.conf.json';
const LICENSE_LIKE_BASENAME = /^(?:licen[cs]e|copying|notice)(?:\.[a-z0-9]+)?$/i;
const THIRD_PARTY_NOTICES_BASENAME = /third[-_ ]?party[-_ ]?notices/i;
/** Written by the e2e application publisher (not by Tauri/NSIS); excluded from shape comparisons. */
const E2E_PUBLICATION_ONLY_ENTRIES = new Set(['.osg-application-manifest.json']);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

/** Both CJS helper modules resolve their own `require.main === module` guard against `import.meta.url`; requiring them via ESM interop only reads their named exports and never re-runs their CLI. */
async function loadCommonJsHelpers() {
  const readiness = await import(pathToFileURL(path.join(SCRIPT_DIRECTORY, 'check-release-readiness.js')).href);
  const artifacts = await import(pathToFileURL(path.join(SCRIPT_DIRECTORY, 'check-release-artifacts.js')).href);
  const versions = await import(pathToFileURL(path.join(SCRIPT_DIRECTORY, 'check-version-consistency.js')).href);
  return {
    applicationBinaryBaseName: artifacts.applicationBinaryBaseName,
    assertAllVersionsMatch: versions.assertAllVersionsMatch,
    assertWindowsMainExecutableArchitecture: artifacts.assertWindowsMainExecutableArchitecture,
    collectRepositoryVersions: versions.collectRepositoryVersions,
    collectResourceMappings: readiness.collectResourceMappings,
    sha256File: readiness.sha256File,
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Every immediate child of `directory`: file and directory names alike, refusing a symlink so an
 * NSIS payload can never smuggle a reparse point past the shape check.
 */
function immediateChildren(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    invariant(!entry.isSymbolicLink(), `Payload entry may not be a symlink: ${path.join(directory, entry.name)}`);
  }
  return entries.map((entry) => entry.name);
}

/** Locates the single main executable anywhere under `root` and returns its absolute path. */
function findMainExecutable(root, executableName) {
  const matches = walkFiles(root).filter(
    (candidate) => path.basename(candidate).toLowerCase() === executableName.toLowerCase(),
  );
  invariant(matches.length === 1,
    `Payload must contain exactly one ${executableName}; found ${matches.length}`);
  return matches[0];
}

/**
 * The top-level shape a shipped NSIS payload must have: the main executable plus exactly the
 * directories `tauri.conf.json`'s declared resources land in
 * (`apps/desktop/src-tauri/tauri.conf.json:66-78`), confirmed empirically against a real published
 * e2e application directory (`workers/`, `licenses/`, `ui-fonts/`; see this module's own residue
 * catalog for the full provenance note) and against `README.md`'s statement that "only
 * `osg-desktop.exe`, `ui-fonts/`, `workers/`, and `licenses/` cross into a second content-addressed
 * application publication."
 */
export function expectedTopLevelEntries(mainExecutableName, mappings) {
  const directories = new Set(mappings.map((mapping) => mapping.destination.split('/')[0]));
  return [mainExecutableName, ...directories].sort();
}

export function auditTopLevelShape(appRoot, mainExecutableName, mappings) {
  const expected = expectedTopLevelEntries(mainExecutableName, mappings);
  const actual = [...immediateChildren(appRoot)].sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((name) => !actualSet.has(name));
  const extra = actual.filter((name) => !expectedSet.has(name));
  return { actual, expected, extra, matches: missing.length === 0 && extra.length === 0, missing };
}

/** Every declared resource lands at its exact destination inside `appRoot` with unmodified bytes. */
export function auditResources(appRoot, mappings, sha256File) {
  const mismatches = [];
  for (const mapping of mappings) {
    const packagedPath = path.join(appRoot, ...mapping.destination.split('/'));
    if (!fs.existsSync(packagedPath)) {
      mismatches.push(`Missing packaged resource: ${mapping.destination}`);
      continue;
    }
    const metadata = fs.lstatSync(packagedPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      mismatches.push(`Packaged resource is not a regular file: ${mapping.destination}`);
      continue;
    }
    if (sha256File(packagedPath) !== sha256File(mapping.sourceAbsolute)) {
      mismatches.push(`Packaged resource differs from its locked source: ${mapping.destination}`);
    }
  }
  return { mismatches, total: mappings.length, verified: mappings.length - mismatches.length };
}

export function findLicenseLikeFiles(root) {
  return walkFiles(root)
    .map((absolute) => path.relative(root, absolute).split(path.sep).join('/'))
    .filter((relative) => {
      const base = path.basename(relative);
      return LICENSE_LIKE_BASENAME.test(base) || THIRD_PARTY_NOTICES_BASENAME.test(base);
    })
    .sort();
}

/**
 * Every license-shaped file the payload ships must be named in `THIRD_PARTY_NOTICES.md`. The
 * notices file always accounts for itself and for the root `LICENSE` (its own "No implied
 * relicensing" section names both explicitly); anything else must appear by name, or this is the
 * notice gap SECURITY.md's "Open notice items" section asks callers to keep surfacing rather than
 * silently accept.
 */
export function auditNotices(rootDirectory, licenseLikeFiles) {
  const noticesPath = path.join(rootDirectory, 'THIRD_PARTY_NOTICES.md');
  invariant(fs.existsSync(noticesPath), 'Repository is missing THIRD_PARTY_NOTICES.md');
  const noticesText = fs.readFileSync(noticesPath, 'utf8').toLowerCase();
  const accounted = [];
  const gaps = [];
  for (const relative of licenseLikeFiles) {
    const base = path.basename(relative);
    const stem = base.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
    const mentioned = THIRD_PARTY_NOTICES_BASENAME.test(base) || noticesText.includes(stem);
    (mentioned ? accounted : gaps).push(relative);
  }
  return { accounted, gaps };
}

/**
 * The Windows Local AppData e2e application-publication cache is dev-machine state, not a
 * repository input: it may not exist on a fresh checkout or a CI runner. Auto-discovery is
 * best-effort corroboration only; its absence is reported, never a failure.
 */
export function discoverLatestE2eReferenceDirectory({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32' || !env.LOCALAPPDATA) return null;
  const applicationsRoot = path.join(env.LOCALAPPDATA, 'OSG-Development', 'cache', 'apps', 'e2e', 'applications');
  if (!fs.existsSync(applicationsRoot)) return null;
  const candidates = fs.readdirSync(applicationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(applicationsRoot, entry.name))
    .map((full) => ({ full, mtimeMs: fs.statSync(full).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.full ?? null;
}

export function crossCheckE2eReference(referenceDirectory, expectedTopLevel) {
  const actual = immediateChildren(referenceDirectory).filter((name) => !E2E_PUBLICATION_ONLY_ENTRIES.has(name));
  const actualSet = new Set(actual);
  const expectedSet = new Set(expectedTopLevel);
  const missing = expectedTopLevel.filter((name) => !actualSet.has(name));
  const extra = actual.filter((name) => !expectedSet.has(name));
  return { extra, matches: missing.length === 0 && extra.length === 0, missing, referenceDirectory };
}

function auditVersionMetadata({ mainExecutablePath, productName, canonicalVersion, readVersionInfo }) {
  const info = readVersionInfo(mainExecutablePath);
  const fileVersionMatches = windowsVersionMatchesSemver(info.FileVersion, canonicalVersion);
  const productVersionMatches = windowsVersionMatchesSemver(info.ProductVersion, canonicalVersion);
  const productNameMatches = info.ProductName === productName;
  const mismatches = [];
  if (!fileVersionMatches) mismatches.push(`FileVersion ${info.FileVersion ?? 'null'} does not match ${canonicalVersion}`);
  if (!productVersionMatches) mismatches.push(`ProductVersion ${info.ProductVersion ?? 'null'} does not match ${canonicalVersion}`);
  if (!productNameMatches) mismatches.push(`ProductName ${JSON.stringify(info.ProductName)} does not match ${JSON.stringify(productName)}`);
  return { canonicalVersion, info, mismatches };
}

/**
 * Inspect a built NSIS payload (either an unexecuted `.exe` extracted with 7-Zip, or an
 * already-extracted directory) for shape, forbidden residue, notice coverage, and executable
 * metadata. Never launches or installs anything.
 */
export async function inspectInstallerPayload({
  rootDirectory = REPOSITORY_ROOT,
  installerPath = null,
  payloadDirectory = null,
  e2eReferenceDirectory,
  extractInstaller = extractNsisInstallerPayload,
  readVersionInfo = readWindowsExecutableVersionInfo,
  helpers,
} = {}) {
  invariant((installerPath === null) !== (payloadDirectory === null),
    'Provide exactly one of an installer path or a pre-extracted payload directory');

  const {
    applicationBinaryBaseName,
    assertAllVersionsMatch,
    assertWindowsMainExecutableArchitecture,
    collectRepositoryVersions,
    collectResourceMappings,
    sha256File,
  } = helpers ?? await loadCommonJsHelpers();

  const tauriConfig = readJson(path.join(rootDirectory, TAURI_CONFIG_RELATIVE));
  const externalBinCount = Array.isArray(tauriConfig.bundle?.externalBin) ? tauriConfig.bundle.externalBin.length : 0;
  const mainExecutableName = `${applicationBinaryBaseName(rootDirectory)}.exe`;
  const mappings = collectResourceMappings(rootDirectory, TARGET);

  let extractionRoot = payloadDirectory;
  let ownsExtraction = false;
  if (installerPath !== null) {
    extractionRoot = extractInstaller(installerPath);
    ownsExtraction = true;
  } else {
    invariant(fs.existsSync(payloadDirectory) && fs.statSync(payloadDirectory).isDirectory(),
      `Payload directory does not exist: ${payloadDirectory}`);
  }

  try {
    assertWindowsMainExecutableArchitecture(extractionRoot, mainExecutableName, TARGET);
    const mainExecutablePath = findMainExecutable(extractionRoot, mainExecutableName);
    const appRoot = path.dirname(mainExecutablePath);

    const topLevelShape = auditTopLevelShape(appRoot, mainExecutableName, mappings);
    const resources = auditResources(appRoot, mappings, sha256File);
    const licenseLikeFiles = findLicenseLikeFiles(extractionRoot);
    const notices = auditNotices(rootDirectory, licenseLikeFiles);
    const residueEntries = walkFiles(extractionRoot)
      .map((absolute) => ({ relativePath: path.relative(extractionRoot, absolute) }));
    const residueViolations = scanForbiddenResidue(residueEntries);

    const { versions } = collectRepositoryVersions(rootDirectory);
    const canonicalVersion = assertAllVersionsMatch(versions);
    const versionMetadata = auditVersionMetadata({
      canonicalVersion,
      mainExecutablePath,
      productName: tauriConfig.productName,
      readVersionInfo,
    });

    let e2eCrossCheck;
    const referenceDirectory = e2eReferenceDirectory === undefined
      ? discoverLatestE2eReferenceDirectory()
      : e2eReferenceDirectory;
    if (referenceDirectory) {
      e2eCrossCheck = { performed: true, ...crossCheckE2eReference(referenceDirectory, topLevelShape.expected) };
    } else {
      e2eCrossCheck = { performed: false, reason: 'no e2e application publication was found to cross-check against' };
    }

    const violations = [
      ...(externalBinCount > 0 ? [`tauri.conf.json declares ${externalBinCount} bundle.externalBin sidecar(s); none are reviewed for this payload`] : []),
      ...(topLevelShape.matches ? [] : [
        ...topLevelShape.missing.map((name) => `Payload top level is missing expected entry: ${name}`),
        ...topLevelShape.extra.map((name) => `Payload top level has an unexpected entry: ${name}`),
      ]),
      ...resources.mismatches,
      ...notices.gaps.map((relative) => `License-like file ships without a THIRD_PARTY_NOTICES.md mention: ${relative}`),
      ...residueViolations.map((violation) => `Forbidden residue at ${violation.path}: ${violation.reason} (${violation.rule})`),
      ...versionMetadata.mismatches,
      ...(e2eCrossCheck.performed && !e2eCrossCheck.matches ? [
        ...e2eCrossCheck.missing.map((name) => `E2E reference publication is missing entry the payload should also carry: ${name}`),
        ...e2eCrossCheck.extra.map((name) => `E2E reference publication carries an entry the payload does not: ${name}`),
      ] : []),
    ];

    return {
      appRoot,
      e2eCrossCheck,
      externalBin: { count: externalBinCount, ok: externalBinCount === 0 },
      mainExecutable: { name: mainExecutableName, path: mainExecutablePath },
      notices,
      pass: violations.length === 0,
      residue: { rulesMatched: residueViolations.length, violations: residueViolations },
      resources,
      source: installerPath !== null ? { kind: 'installer', path: installerPath } : { kind: 'payload-dir', path: payloadDirectory },
      target: TARGET,
      topLevelShape,
      versionMetadata,
      violations,
    };
  } finally {
    if (ownsExtraction) {
      fs.rmSync(extractionRoot, { force: true, recursive: true });
    }
  }
}

export function parseArguments(argv) {
  const options = { e2eReferenceDirectory: undefined, jsonOut: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--installer') {
      options.installerPath = argv[index += 1];
    } else if (flag === '--payload-dir') {
      options.payloadDirectory = argv[index += 1];
    } else if (flag === '--root') {
      options.rootDirectory = argv[index += 1];
    } else if (flag === '--e2e-reference') {
      const value = argv[index += 1];
      options.e2eReferenceDirectory = value === 'none' ? null : value;
    } else if (flag === '--json-out') {
      options.jsonOut = argv[index += 1];
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  invariant((options.installerPath ?? null) !== null || (options.payloadDirectory ?? null) !== null,
    'Usage: inspect-installer-payload.mjs (--installer PATH | --payload-dir PATH) [--root PATH] [--e2e-reference PATH|none] [--json-out PATH]');
  invariant(!(options.installerPath && options.payloadDirectory), 'Provide only one of --installer or --payload-dir');
  return options;
}

function printHumanReport(report) {
  console.log(`Installer payload inspection: ${report.pass ? 'PASS' : 'FAIL'} (${report.source.kind}: ${report.source.path})`);
  console.log(`  Main executable: ${report.mainExecutable.name} at ${report.mainExecutable.path}`);
  console.log(`  Top-level shape: ${report.topLevelShape.matches ? 'matches' : 'MISMATCH'} (${report.topLevelShape.actual.join(', ')})`);
  console.log(`  Resources verified: ${report.resources.verified}/${report.resources.total}`);
  console.log(`  Forbidden residue matches: ${report.residue.rulesMatched}`);
  console.log(`  Notices: ${report.notices.accounted.length} accounted, ${report.notices.gaps.length} gap(s)`);
  console.log(`  Version: ${report.versionMetadata.info.FileVersion ?? 'unknown'} (expected ${report.versionMetadata.canonicalVersion})`);
  console.log(`  E2E cross-check: ${report.e2eCrossCheck.performed ? (report.e2eCrossCheck.matches ? 'matches' : 'MISMATCH') : 'skipped (' + report.e2eCrossCheck.reason + ')'}`);
  const MAX_LISTED_VIOLATIONS = 50;
  for (const violation of report.violations.slice(0, MAX_LISTED_VIOLATIONS)) {
    console.log(`  VIOLATION: ${violation}`);
  }
  if (report.violations.length > MAX_LISTED_VIOLATIONS) {
    console.log(`  ...and ${report.violations.length - MAX_LISTED_VIOLATIONS} more violation(s)`);
  }
}

function summaryOf(report) {
  return {
    e2eCrossCheckPerformed: report.e2eCrossCheck.performed,
    mainExecutable: report.mainExecutable.name,
    noticeGaps: report.notices.gaps.length,
    pass: report.pass,
    residueMatches: report.residue.rulesMatched,
    resourcesVerified: `${report.resources.verified}/${report.resources.total}`,
    target: report.target,
    topLevelShapeMatches: report.topLevelShape.matches,
    violationCount: report.violations.length,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.installerPath) {
    const availability = sevenZipAvailability();
    if (!availability.available) {
      console.log('Note: no 7-Zip executable was located; extraction will fail. Pre-extract the '
        + 'installer and pass --payload-dir instead, or install the locked `7zip-bin-full` package.');
    }
  }
  const report = await inspectInstallerPayload(options);
  printHumanReport(report);
  if (options.jsonOut) {
    fs.writeFileSync(options.jsonOut, JSON.stringify(report, null, 2));
  }
  console.log(`JSON_SUMMARY ${JSON.stringify(summaryOf(report))}`);
  if (!report.pass) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Installer payload inspection failed: ${error.message}`);
    process.exitCode = 1;
  });
}
