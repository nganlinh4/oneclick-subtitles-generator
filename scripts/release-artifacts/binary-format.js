'use strict';

// Container magic and machine architecture of release artifacts and their main executables.

const fs = require('node:fs');
const path = require('node:path');

const { REPOSITORY_ROOT } = require('../release-readiness/shared');
const { invariant } = require('./bundles');

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

module.exports = {
  applicationBinaryBaseName,
  assertArtifactArchitecture,
  assertArtifactMagic,
  assertLinuxMainExecutableArchitecture,
  assertWindowsMainExecutableArchitecture,
  exactlyOneMainExecutable,
  readElfArchitecture,
  readMachCpuTypes,
  readPeMachine,
  walkRegularFiles,
};
