#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, createPublicKey, verify } = require('node:crypto');
const { TextDecoder } = require('node:util');

const {
  TARGETS,
  collectResourceMappings,
  sha256File,
} = require('./check-release-readiness');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');

const BUNDLE_LAYOUTS = Object.freeze({
  appimage: Object.freeze({ directory: 'appimage', extension: '.AppImage', kind: 'file' }),
  deb: Object.freeze({ directory: 'deb', extension: '.deb', kind: 'file' }),
  app: Object.freeze({ directory: 'macos', extension: '.app', kind: 'directory' }),
  dmg: Object.freeze({ directory: 'dmg', extension: '.dmg', kind: 'file' }),
  nsis: Object.freeze({ directory: 'nsis', extension: '.exe', kind: 'file' }),
});

const TARGET_BUNDLES = Object.freeze({
  'x86_64-unknown-linux-gnu': new Set(['appimage', 'deb']),
  'aarch64-apple-darwin': new Set(['app', 'dmg']),
  'x86_64-apple-darwin': new Set(['app', 'dmg']),
  'x86_64-pc-windows-msvc': new Set(['nsis']),
});

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function decodeCanonicalBase64(value, label) {
  invariant(typeof value === 'string' && value.length > 0, `${label} is empty`);
  invariant(
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0,
    `${label} is not canonical base64`,
  );
  const decoded = Buffer.from(value, 'base64');
  invariant(decoded.toString('base64') === value, `${label} is not canonical base64`);
  return decoded;
}

function decodeUtf8Envelope(encoded, label) {
  const bytes = decodeCanonicalBase64(encoded.trim(), label);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not UTF-8`);
  }
}

function envelopeLines(value, expectedCount, label) {
  const normalized = value.endsWith('\n') ? value.slice(0, -1) : value;
  invariant(!normalized.includes('\r'), `${label} must use canonical LF line endings`);
  const lines = normalized.split('\n');
  invariant(lines.length === expectedCount, `${label} has an invalid line count`);
  return lines;
}

function verifyUpdaterSignature(artifact, signaturePath, encodedPublicKey) {
  const publicEnvelope = decodeUtf8Envelope(encodedPublicKey, 'Updater public key');
  const publicLines = envelopeLines(publicEnvelope, 2, 'Updater public key');
  invariant(
    publicLines[0].startsWith('untrusted comment:'),
    'Updater public key has no Minisign comment',
  );
  const publicBytes = decodeCanonicalBase64(publicLines[1], 'Updater public key payload');
  invariant(publicBytes.length === 42, 'Updater public key payload has an invalid length');
  invariant(
    (publicBytes[0] === 0x45 && publicBytes[1] === 0x64)
      || (publicBytes[0] === 0x45 && publicBytes[1] === 0x44),
    'Updater public key uses an unsupported algorithm',
  );

  invariant(fs.existsSync(signaturePath), `Updater signature is missing: ${signaturePath}`);
  const signatureOuter = fs.readFileSync(signaturePath, 'utf8').trim();
  const signatureEnvelope = decodeUtf8Envelope(signatureOuter, 'Updater signature');
  const signatureLines = envelopeLines(signatureEnvelope, 4, 'Updater signature');
  invariant(
    signatureLines[0].startsWith('untrusted comment:'),
    'Updater signature has no Minisign comment',
  );
  invariant(
    signatureLines[2].startsWith('trusted comment: '),
    'Updater signature has no trusted comment',
  );
  const signatureBytes = decodeCanonicalBase64(signatureLines[1], 'Updater signature payload');
  const globalSignature = decodeCanonicalBase64(signatureLines[3], 'Updater global signature');
  invariant(signatureBytes.length === 74, 'Updater signature payload has an invalid length');
  invariant(globalSignature.length === 64, 'Updater global signature has an invalid length');
  invariant(
    signatureBytes[0] === 0x45 && signatureBytes[1] === 0x44,
    'Updater signature must use prehashed Minisign mode',
  );
  invariant(
    publicBytes.subarray(2, 10).equals(signatureBytes.subarray(2, 10)),
    'Updater signature key ID does not match the configured public key',
  );

  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    publicBytes.subarray(10),
  ]);
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const artifactDigest = createHash('blake2b512').update(fs.readFileSync(artifact)).digest();
  invariant(
    verify(null, artifactDigest, key, signatureBytes.subarray(10)),
    `Updater signature does not authenticate ${path.basename(artifact)}`,
  );
  const trustedComment = Buffer.from(signatureLines[2].slice('trusted comment: '.length), 'utf8');
  invariant(
    verify(
      null,
      Buffer.concat([signatureBytes.subarray(10), trustedComment]),
      key,
      globalSignature,
    ),
    'Updater trusted comment signature is invalid',
  );
}

function assertUpdaterSignature(artifact, rootDirectory = REPOSITORY_ROOT) {
  const config = JSON.parse(
    fs.readFileSync(path.join(rootDirectory, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
  );
  invariant(
    config.bundle?.createUpdaterArtifacts === true,
    'Tauri must create updater artifacts for release installers',
  );
  const encodedPublicKey = config.plugins?.updater?.pubkey;
  invariant(typeof encodedPublicKey === 'string', 'Tauri updater public key is missing');
  verifyUpdaterSignature(artifact, `${artifact}.sig`, encodedPublicKey);
}

function parseArguments(arguments_) {
  let target;
  let bundles;
  let targetDirectory = 'target';
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--target') {
      target = arguments_[index + 1];
      index += 1;
    } else if (argument === '--bundles') {
      bundles = arguments_[index + 1];
      index += 1;
    } else if (argument === '--target-dir') {
      targetDirectory = arguments_[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}`);
    }
  }

  invariant(target && TARGETS[target], 'Artifact validation requires a supported --target triple');
  invariant(typeof bundles === 'string' && bundles.trim(), 'Artifact validation requires --bundles');
  invariant(typeof targetDirectory === 'string' && targetDirectory.trim(), '--target-dir must be non-empty');
  const bundleNames = bundles
    .split(/[\s,]+/)
    .map((bundle) => bundle.toLowerCase())
    .filter(Boolean);
  invariant(bundleNames.length > 0, '--bundles must contain at least one bundle type');
  invariant(new Set(bundleNames).size === bundleNames.length, '--bundles may not contain duplicates');
  const supportedBundles = TARGET_BUNDLES[target];
  for (const bundle of bundleNames) {
    invariant(BUNDLE_LAYOUTS[bundle], `Unsupported bundle type ${JSON.stringify(bundle)}`);
    invariant(supportedBundles.has(bundle), `${bundle} is not a native bundle for ${target}`);
  }
  return { bundleNames, target, targetDirectory };
}

function listMatchingArtifacts(bundleRoot, bundleName) {
  const layout = BUNDLE_LAYOUTS[bundleName];
  const directory = path.join(bundleRoot, layout.directory);
  invariant(fs.existsSync(directory), `Tauri did not create ${path.relative(REPOSITORY_ROOT, directory)}`);
  const artifacts = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.toLowerCase().endsWith(layout.extension.toLowerCase()))
    .filter((entry) => (layout.kind === 'file' ? entry.isFile() : entry.isDirectory()))
    .map((entry) => path.join(directory, entry.name));
  invariant(artifacts.length > 0, `Tauri did not create a ${bundleName} artifact in ${directory}`);
  return artifacts;
}

function assertSafeArtifact(artifact, kind, target) {
  const metadata = fs.lstatSync(artifact);
  invariant(!metadata.isSymbolicLink(), `Release artifact may not be a symlink: ${artifact}`);
  if (kind === 'file') {
    invariant(metadata.isFile() && metadata.size > 0, `Release artifact is empty or invalid: ${artifact}`);
    assertArtifactMagic(artifact, metadata.size);
    assertArtifactArchitecture(artifact, target);
    if (path.extname(artifact).toLowerCase() === '.appimage' && process.platform !== 'win32') {
      invariant((metadata.mode & 0o111) !== 0, `AppImage is not executable: ${artifact}`);
    }
    return;
  }
  invariant(metadata.isDirectory(), `Release application bundle is invalid: ${artifact}`);
  const files = walkRegularFiles(artifact);
  invariant(files.length > 0, `Release application bundle is empty: ${artifact}`);
}

function readBytes(filePath, length, position = 0) {
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(length);
  try {
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readPeMachine(filePath) {
  const metadata = fs.statSync(filePath);
  invariant(metadata.size >= 0x46, `PE executable is too small: ${filePath}`);
  const dosHeader = readBytes(filePath, 0x40);
  invariant(dosHeader.subarray(0, 2).equals(Buffer.from('MZ')), `Executable has no DOS header: ${filePath}`);
  const peOffset = dosHeader.readUInt32LE(0x3c);
  invariant(
    peOffset >= 0x40 && peOffset <= metadata.size - 6,
    `PE header offset is invalid: ${filePath}`,
  );
  const peHeader = readBytes(filePath, 6, peOffset);
  invariant(peHeader.subarray(0, 4).equals(Buffer.from('PE\0\0')), `Executable has no PE header: ${filePath}`);
  return peHeader.readUInt16LE(4);
}

function readElfArchitecture(filePath) {
  const header = readBytes(filePath, 20);
  invariant(header.length === 20, `ELF executable is too small: ${filePath}`);
  invariant(
    header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
    `Executable has no ELF header: ${filePath}`,
  );
  invariant(header[4] === 1 || header[4] === 2, `ELF class is unsupported: ${filePath}`);
  invariant(header[5] === 1 || header[5] === 2, `ELF byte order is unsupported: ${filePath}`);
  return {
    bits: header[4] === 2 ? 64 : 32,
    machine: header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18),
  };
}

function readMachCpuTypes(filePath) {
  const prefix = readBytes(filePath, 8);
  invariant(prefix.length === 8, `Mach-O executable is too small: ${filePath}`);
  const magic = prefix.subarray(0, 4).toString('hex');
  const thinFormats = new Map([
    ['cefaedfe', 'little'],
    ['cffaedfe', 'little'],
    ['feedface', 'big'],
    ['feedfacf', 'big'],
  ]);
  if (thinFormats.has(magic)) {
    return new Set([
      thinFormats.get(magic) === 'little' ? prefix.readUInt32LE(4) : prefix.readUInt32BE(4),
    ]);
  }

  const fatFormats = new Map([
    ['cafebabe', { byteOrder: 'big', entrySize: 20 }],
    ['bebafeca', { byteOrder: 'little', entrySize: 20 }],
    ['cafebabf', { byteOrder: 'big', entrySize: 24 }],
    ['bfbafeca', { byteOrder: 'little', entrySize: 24 }],
  ]);
  const format = fatFormats.get(magic);
  invariant(format, `Executable has no supported Mach-O header: ${filePath}`);
  const count = format.byteOrder === 'little' ? prefix.readUInt32LE(4) : prefix.readUInt32BE(4);
  invariant(count > 0 && count <= 32, `Mach-O architecture count is invalid: ${filePath}`);
  const table = readBytes(filePath, 8 + count * format.entrySize);
  invariant(table.length === 8 + count * format.entrySize, `Mach-O architecture table is truncated: ${filePath}`);
  const cpuTypes = new Set();
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * format.entrySize;
    cpuTypes.add(
      format.byteOrder === 'little' ? table.readUInt32LE(offset) : table.readUInt32BE(offset),
    );
  }
  return cpuTypes;
}

function assertArtifactArchitecture(artifact, target) {
  if (!target || path.extname(artifact).toLowerCase() !== '.appimage') {
    return;
  }
  invariant(target === 'x86_64-unknown-linux-gnu', `No AppImage architecture rule exists for ${target}`);
  const architecture = readElfArchitecture(artifact);
  invariant(
    architecture.bits === 64 && architecture.machine === 0x3e,
    `AppImage architecture does not match ${target}: ${artifact}`,
  );
}

function applicationBinaryBaseName(rootDirectory = REPOSITORY_ROOT) {
  const config = JSON.parse(
    fs.readFileSync(path.join(rootDirectory, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
  );
  let binaryName = config.mainBinaryName;
  if (binaryName === undefined) {
    const cargoManifest = fs.readFileSync(
      path.join(rootDirectory, 'apps/desktop/src-tauri/Cargo.toml'),
      'utf8',
    );
    const packageHeading = /^\s*\[package]\s*$/m.exec(cargoManifest);
    invariant(packageHeading, 'Desktop Cargo.toml is missing [package]');
    const afterHeading = cargoManifest.slice(packageHeading.index + packageHeading[0].length);
    const nextHeading = /^\s*\[[^\]]+]\s*$/m.exec(afterHeading);
    const packageSection = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;
    const value = (key) => {
      const match = packageSection.match(
        new RegExp(`^\\s*${key.replace('-', '\\-')}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`, 'm'),
      );
      return match && match[1];
    };
    binaryName = value('default-run') || value('name');
  }
  invariant(
    typeof binaryName === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(binaryName),
    'Desktop main binary name is missing or unsafe',
  );
  return binaryName;
}

function exactlyOneMainExecutable(directory, executableName, label) {
  const matches = walkRegularFiles(directory).filter(
    (candidate) => path.basename(candidate).toLowerCase() === executableName.toLowerCase(),
  );
  invariant(matches.length === 1,
    `${label} must contain exactly one ${executableName}; found ${matches.length}`);
  return matches[0];
}

function assertWindowsMainExecutableArchitecture(
  extractionDirectory,
  executableName,
  target,
) {
  invariant(target === 'x86_64-pc-windows-msvc', `No Windows architecture rule exists for ${target}`);
  const executable = exactlyOneMainExecutable(
    extractionDirectory,
    executableName,
    'NSIS application payload',
  );
  invariant(
    readPeMachine(executable) === 0x8664,
    `NSIS main executable ${executableName} does not match ${target}`,
  );
}

function assertLinuxMainExecutableArchitecture(
  extractionDirectory,
  executableName,
  target,
  label = 'Linux application payload',
) {
  invariant(target === 'x86_64-unknown-linux-gnu', `No Linux architecture rule exists for ${target}`);
  const executable = exactlyOneMainExecutable(extractionDirectory, executableName, label);
  const architecture = readElfArchitecture(executable);
  invariant(
    architecture.bits === 64 && architecture.machine === 0x3e,
    `${label} main executable ${executableName} does not match ${target}`,
  );
}

function assertArtifactMagic(artifact, size) {
  const extension = path.extname(artifact).toLowerCase();
  if (extension === '.exe') {
    invariant(readBytes(artifact, 2).equals(Buffer.from('MZ')), `Windows installer has no PE/NSIS signature: ${artifact}`);
  } else if (extension === '.deb') {
    invariant(readBytes(artifact, 8).equals(Buffer.from('!<arch>\n')), `Debian package has no ar signature: ${artifact}`);
  } else if (extension === '.appimage') {
    invariant(
      readBytes(artifact, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
      `AppImage has no ELF signature: ${artifact}`,
    );
  } else if (extension === '.dmg') {
    invariant(size >= 512, `DMG is too small to contain a UDIF trailer: ${artifact}`);
    invariant(
      readBytes(artifact, 4, size - 512).equals(Buffer.from('koly')),
      `DMG has no UDIF trailer: ${artifact}`,
    );
  }
}

function walkRegularFiles(directory) {
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const metadata = fs.lstatSync(entryPath);
    // Installer formats and macOS frameworks may contain legitimate internal
    // symlinks. Never follow them during validation; declared resources are
    // checked separately and must themselves be regular files.
    if (metadata.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      results.push(...walkRegularFiles(entryPath));
    } else if (entry.isFile()) {
      results.push(entryPath);
    }
  }
  return results;
}

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

function validateReleaseArtifacts({
  rootDirectory = REPOSITORY_ROOT,
  target,
  bundleNames,
  targetDirectory = 'target',
}) {
  invariant(TARGETS[target], `Unsupported release target ${JSON.stringify(target)}`);
  const bundleRoot = path.resolve(rootDirectory, targetDirectory, target, 'release', 'bundle');
  const relativeBundleRoot = path.relative(rootDirectory, bundleRoot);
  invariant(
    relativeBundleRoot && !relativeBundleRoot.startsWith('..') && !path.isAbsolute(relativeBundleRoot),
    'The artifact target directory must stay inside the repository',
  );
  const mappings = collectResourceMappings(rootDirectory, target);
  let artifactCount = 0;
  for (const bundleName of bundleNames) {
    invariant(TARGET_BUNDLES[target].has(bundleName), `${bundleName} is not a native bundle for ${target}`);
    const layout = BUNDLE_LAYOUTS[bundleName];
    const artifacts = listMatchingArtifacts(bundleRoot, bundleName);
    artifactCount += artifacts.length;
    for (const artifact of artifacts) {
      assertSafeArtifact(artifact, layout.kind, target);
      if (bundleName === 'app') {
        inspectMacApplication(artifact, mappings, target, rootDirectory);
      } else if (bundleName === 'deb') {
        inspectDebianPackage(artifact, mappings, target, rootDirectory);
      } else if (bundleName === 'appimage') {
        inspectAppImagePackage(artifact, mappings, target, rootDirectory);
      } else if (bundleName === 'dmg') {
        inspectDmgPackage(artifact, mappings, target, rootDirectory);
      } else if (bundleName === 'nsis') {
        inspectNsisPackage(artifact, mappings, target, rootDirectory);
        assertUpdaterSignature(artifact, rootDirectory);
      }
    }
  }
  return { artifactCount, bundleRoot, resourceCount: mappings.length };
}

function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const report = validateReleaseArtifacts(arguments_);
  console.log(
    `Release artifacts passed for ${arguments_.target}: ${report.artifactCount} artifacts, ${report.resourceCount} packaged resources.`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Release artifact validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  BUNDLE_LAYOUTS,
  TARGET_BUNDLES,
  applicationBinaryBaseName,
  assertLinuxMainExecutableArchitecture,
  assertArtifactMagic,
  assertArtifactArchitecture,
  assertUpdaterSignature,
  assertExactResourceCopies,
  assertResourceCopiesBySuffix,
  assertSafeArtifact,
  assertSevenZipFormatSupport,
  assertWindowsMainExecutableArchitecture,
  inspectAppImagePackage,
  inspectDmgPackage,
  inspectMacApplication,
  inspectNsisPackage,
  listMatchingArtifacts,
  parseArguments,
  pathEndsWith,
  readElfArchitecture,
  readMachCpuTypes,
  readPeMachine,
  validateReleaseArtifacts,
  verifyUpdaterSignature,
};
