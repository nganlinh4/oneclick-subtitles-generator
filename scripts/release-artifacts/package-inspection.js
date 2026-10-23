'use strict';

// Extract or mount each native package read-only and prove it ships every reviewed resource
// byte-for-byte beside a main executable of the target architecture.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { REPOSITORY_ROOT, sha256File } = require('../release-readiness/shared');
const {
  applicationBinaryBaseName,
  assertLinuxMainExecutableArchitecture,
  assertWindowsMainExecutableArchitecture,
  exactlyOneMainExecutable,
  readMachCpuTypes,
  walkRegularFiles,
} = require('./binary-format');
const { invariant } = require('./bundles');

function assertExactResourceCopies(resourceRoot, mappings) {
  for (const mapping of mappings) {
    const packagedPath = path.resolve(resourceRoot, ...mapping.destination.split('/'));
    const relativePath = path.relative(resourceRoot, packagedPath);
    invariant(
      relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath),
      `Packaged resource escaped its resource root: ${mapping.destination}`,
    );
    invariant(fs.existsSync(packagedPath), `Packaged application is missing resource ${mapping.destination}`);
    const metadata = fs.lstatSync(packagedPath);
    invariant(
      metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0,
      `Packaged resource is invalid: ${mapping.destination}`,
    );
    invariant(
      sha256File(packagedPath) === sha256File(mapping.sourceAbsolute),
      `Packaged resource differs from its locked source: ${mapping.destination}`,
    );
  }
}

function pathEndsWith(relativePath, destination) {
  const normalizedPath = relativePath.replaceAll('\\', '/');
  return normalizedPath === destination || normalizedPath.endsWith(`/${destination}`);
}

function assertResourceCopiesBySuffix(extractedRoot, mappings) {
  const files = walkRegularFiles(extractedRoot);
  for (const mapping of mappings) {
    const matches = files.filter((candidate) =>
      pathEndsWith(path.relative(extractedRoot, candidate), mapping.destination),
    );
    invariant(matches.length === 1,
      `Package must contain exactly one resource destination ${mapping.destination}; found ${matches.length}`);
    invariant(
      sha256File(matches[0]) === sha256File(mapping.sourceAbsolute),
      `Package resource differs from its locked source: ${mapping.destination}`,
    );
  }
}

function runInspectionTool(command, arguments_, options, label) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
  invariant(!result.error, `Could not run ${label}: ${result.error && result.error.message}`);
  invariant(
    result.status === 0,
    `${label} rejected the release artifact: ${(result.stderr || result.stdout || '').trim()}`,
  );
  return result;
}

function inspectAppImagePackage(appImage, mappings, target, rootDirectory = REPOSITORY_ROOT) {
  invariant(process.platform === 'linux', 'AppImage inspection must run on its Linux release host');
  const extractionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-appimage-inspection-'));
  try {
    runInspectionTool(
      appImage,
      ['--appimage-extract'],
      { cwd: extractionDirectory },
      'AppImage self-extractor',
    );
    const extractedRoot = path.join(extractionDirectory, 'squashfs-root');
    invariant(fs.existsSync(extractedRoot), 'AppImage extraction did not create squashfs-root');
    const files = walkRegularFiles(extractedRoot);
    invariant(
      files.some((candidate) => (fs.statSync(candidate).mode & 0o111) !== 0),
      'AppImage contains no executable payload',
    );
    assertLinuxMainExecutableArchitecture(
      extractedRoot,
      applicationBinaryBaseName(rootDirectory),
      target,
      'AppImage application payload',
    );
    assertResourceCopiesBySuffix(extractedRoot, mappings);
  } finally {
    fs.rmSync(extractionDirectory, { force: true, recursive: true });
  }
}

function inspectDmgPackage(dmg, mappings, target, rootDirectory = REPOSITORY_ROOT) {
  invariant(process.platform === 'darwin', 'DMG inspection must run on its macOS release host');
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-dmg-inspection-'));
  let mounted = false;
  let detachFailure = null;
  try {
    runInspectionTool(
      'hdiutil',
      ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmg],
      {},
      'hdiutil attach',
    );
    mounted = true;
    const applications = fs.readdirSync(mountPoint, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().endsWith('.app'))
      .map((entry) => path.join(mountPoint, entry.name));
    invariant(applications.length === 1,
      `DMG must contain exactly one macOS application bundle; found ${applications.length}`);
    inspectMacApplication(applications[0], mappings, target, rootDirectory);
  } finally {
    if (mounted) {
      const detached = spawnSync('hdiutil', ['detach', '-force', mountPoint], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
      if (detached.error || detached.status !== 0) {
        detachFailure = `Could not detach inspected DMG: ${(
          detached.stderr || detached.stdout || detached.error?.message || ''
        ).trim()}`;
      }
    }
    if (detachFailure === null) {
      fs.rmSync(mountPoint, { force: true, recursive: true });
    }
    invariant(detachFailure === null, detachFailure);
  }
}

function sevenZipExecutable() {
  let executable;
  try {
    ({ path7z: executable } = require('7zip-bin-full'));
  } catch {
    throw new Error('NSIS inspection requires the locked 7zip-bin-full package');
  }
  invariant(typeof executable === 'string' && fs.existsSync(executable),
    'NSIS inspection could not locate the locked 7-Zip executable');
  const information = runInspectionTool(executable, ['i'], {}, '7-Zip capability inspection');
  assertSevenZipFormatSupport(`${information.stdout || ''}\n${information.stderr || ''}`);
  return executable;
}

function assertSevenZipFormatSupport(output) {
  invariant(typeof output === 'string', 'Locked 7-Zip capability output is invalid');
  const lines = output.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim() === 'Formats:');
  invariant(heading >= 0, 'Locked 7-Zip did not report its supported formats');
  const sectionEnd = lines.findIndex(
    (line, index) => index > heading && /^(?:Codecs|Hashers):\s*$/.test(line.trim()),
  );
  const formatLines = lines.slice(heading + 1, sectionEnd < 0 ? undefined : sectionEnd);
  const supports = (format) => formatLines.some((line) =>
    line.trim().split(/\s+/).includes(format),
  );
  invariant(supports('Nsis'),
    'Locked 7-Zip does not advertise NSIS format support');
  invariant(supports('PE'),
    'Locked 7-Zip does not advertise PE format support');
}

function extractWithSevenZip(executable, archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  runInspectionTool(
    executable,
    ['x', '-bd', '-y', `-o${destination}`, archive],
    {},
    `7-Zip extraction of ${path.basename(archive)}`,
  );
}

function inspectNsisPackage(installer, mappings, target, rootDirectory = REPOSITORY_ROOT) {
  const extractionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-nsis-inspection-'));
  try {
    const executable = sevenZipExecutable();
    extractWithSevenZip(executable, installer, extractionDirectory);
    const nestedArchives = walkRegularFiles(extractionDirectory)
      .filter((candidate) => candidate.toLowerCase().endsWith('.7z'));
    invariant(nestedArchives.length <= 16,
      `NSIS package contains too many nested application archives: ${nestedArchives.length}`);
    nestedArchives.forEach((archive, index) => {
      extractWithSevenZip(
        executable,
        archive,
        path.join(extractionDirectory, `.osg-nested-${index}`),
      );
    });
    assertWindowsMainExecutableArchitecture(
      extractionDirectory,
      `${applicationBinaryBaseName(rootDirectory)}.exe`,
      target,
    );
    assertResourceCopiesBySuffix(extractionDirectory, mappings);
  } finally {
    fs.rmSync(extractionDirectory, { force: true, recursive: true });
  }
}

function inspectMacApplication(applicationBundle, mappings, target, rootDirectory = REPOSITORY_ROOT) {
  const contents = path.join(applicationBundle, 'Contents');
  const executableDirectory = path.join(contents, 'MacOS');
  const resourceDirectory = path.join(contents, 'Resources');
  invariant(fs.existsSync(executableDirectory), `macOS app is missing Contents/MacOS: ${applicationBundle}`);
  invariant(fs.existsSync(resourceDirectory), `macOS app is missing Contents/Resources: ${applicationBundle}`);
  const executables = walkRegularFiles(executableDirectory);
  invariant(executables.length > 0, `macOS app has no executable payload: ${applicationBundle}`);
  if (process.platform !== 'win32') {
    invariant(
      executables.some((candidate) => (fs.statSync(candidate).mode & 0o111) !== 0),
      `macOS app executable payload has no executable bit: ${applicationBundle}`,
    );
  }
  const expectedCpuType = {
    'aarch64-apple-darwin': 0x0100000c,
    'x86_64-apple-darwin': 0x01000007,
  }[target];
  invariant(expectedCpuType, `No macOS architecture rule exists for ${target}`);
  const mainExecutable = exactlyOneMainExecutable(
    executableDirectory,
    applicationBinaryBaseName(rootDirectory),
    'macOS application bundle',
  );
  const cpuTypes = readMachCpuTypes(mainExecutable);
  invariant(
    cpuTypes.has(expectedCpuType),
    `macOS app contains no executable for ${target}: ${applicationBundle}`,
  );
  assertExactResourceCopies(resourceDirectory, mappings);
}

function inspectDebianPackage(debianPackage, mappings, target, rootDirectory = REPOSITORY_ROOT) {
  const extractionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-deb-inspection-'));
  try {
    invariant(target === 'x86_64-unknown-linux-gnu', `No Debian architecture rule exists for ${target}`);
    const architecture = runInspectionTool(
      'dpkg-deb',
      ['--field', debianPackage, 'Architecture'],
      {},
      'dpkg-deb architecture inspection',
    ).stdout.trim();
    invariant(architecture === 'amd64',
      `Debian package architecture ${JSON.stringify(architecture)} does not match ${target}`);
    const result = spawnSync('dpkg-deb', ['--extract', debianPackage, extractionDirectory], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    invariant(!result.error, `Could not run dpkg-deb: ${result.error && result.error.message}`);
    invariant(
      result.status === 0,
      `dpkg-deb rejected ${path.basename(debianPackage)}: ${(result.stderr || result.stdout || '').trim()}`,
    );
    const files = walkRegularFiles(extractionDirectory);
    invariant(
      files.some((candidate) => {
        const relative = path.relative(extractionDirectory, candidate).replaceAll('\\', '/');
        return relative.startsWith('usr/bin/') && (fs.statSync(candidate).mode & 0o111) !== 0;
      }),
      'Debian package contains no executable under usr/bin',
    );
    assertLinuxMainExecutableArchitecture(
      path.join(extractionDirectory, 'usr', 'bin'),
      applicationBinaryBaseName(rootDirectory),
      target,
      'Debian application payload',
    );
    assertResourceCopiesBySuffix(extractionDirectory, mappings);
  } finally {
    fs.rmSync(extractionDirectory, { force: true, recursive: true });
  }
}

module.exports = {
  assertExactResourceCopies,
  assertResourceCopiesBySuffix,
  assertSevenZipFormatSupport,
  inspectAppImagePackage,
  inspectDebianPackage,
  inspectDmgPackage,
  inspectMacApplication,
  inspectNsisPackage,
  pathEndsWith,
};
