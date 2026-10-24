'use strict';

// Repository paths, release targets, and the small file/TOML helpers every readiness module uses.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const TAURI_DIRECTORY = 'apps/desktop/src-tauri';
const TAURI_CONFIG_PATH = `${TAURI_DIRECTORY}/tauri.conf.json`;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

const RELEASE_MATRIX = Object.freeze([
  Object.freeze({
    platform: 'Linux x64',
    os: 'ubuntu-24.04',
    target: 'x86_64-unknown-linux-gnu',
    bundles: 'appimage,deb',
  }),
  Object.freeze({
    platform: 'macOS arm64',
    os: 'macos-15',
    target: 'aarch64-apple-darwin',
    bundles: 'app,dmg',
  }),
  Object.freeze({
    platform: 'Windows x64',
    os: 'windows-2022',
    target: 'x86_64-pc-windows-msvc',
    bundles: 'nsis',
  }),
]);

const TARGETS = Object.freeze(
  Object.fromEntries(RELEASE_MATRIX.map((entry) => [entry.target, entry])),
);

const ENGINE_PLATFORM_BY_TARGET = Object.freeze({
  'x86_64-unknown-linux-gnu': 'linux-x86_64',
  'aarch64-apple-darwin': 'macos-aarch64',
  'x86_64-apple-darwin': 'macos-x86_64',
  'x86_64-pc-windows-msvc': 'windows-x86_64',
});

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readText(rootDirectory, relativePath) {
  const absolutePath = path.join(rootDirectory, relativePath);
  try {
    return fs.readFileSync(absolutePath, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  } catch (error) {
    throw new Error(`Could not read ${relativePath}: ${error.message}`);
  }
}

function readJson(rootDirectory, relativePath) {
  try {
    return JSON.parse(readText(rootDirectory, relativePath));
  } catch (error) {
    throw new Error(`Could not parse ${relativePath}: ${error.message}`);
  }
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTomlSection(toml, sectionName) {
  const sectionLines = [];
  let found = false;
  for (const line of toml.split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (heading) {
      if (found) {
        break;
      }
      found = heading[1].trim() === sectionName;
      continue;
    }
    if (found) {
      sectionLines.push(line);
    }
  }
  invariant(found, `Cargo.toml is missing [${sectionName}]`);
  return sectionLines.join('\n');
}

function extractTomlString(section, key, sourceName) {
  const match = section.match(
    new RegExp(`^\\s*${escapeRegularExpression(key)}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`, 'm'),
  );
  invariant(match, `${sourceName} is missing a string ${key}`);
  return match[1];
}

function walkFiles(directory, predicate, ignoredNames = new Set()) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(entryPath, predicate, ignoredNames));
    } else if (entry.isFile() && predicate(entryPath)) {
      results.push(entryPath);
    }
  }
  return results;
}

function toRepositoryPath(rootDirectory, absolutePath) {
  return path.relative(rootDirectory, absolutePath).replaceAll('\\', '/');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

module.exports = {
  ENGINE_PLATFORM_BY_TARGET,
  EXACT_VERSION,
  RELEASE_MATRIX,
  REPOSITORY_ROOT,
  TARGETS,
  TAURI_CONFIG_PATH,
  TAURI_DIRECTORY,
  escapeRegularExpression,
  extractTomlSection,
  extractTomlString,
  invariant,
  readJson,
  readText,
  sha256File,
  toRepositoryPath,
  walkFiles,
};
