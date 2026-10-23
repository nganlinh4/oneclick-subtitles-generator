'use strict';

// Owner-private, create-once file writes and exact-schema JSON reads for the E2E application store.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const { assertPublishedFile } = require('../publication-paths');

const safeTemporaryLeaf = (prefix) => (
  `${prefix}-${process.pid}-${randomBytes(16).toString('hex')}`
);

const writePrivateFile = (file, bytes) => {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const assertOwnedPrivateTemporaryFile = (file, label) => {
  assertPublishedFile(file, label);
  const status = fs.lstatSync(file);
  if (process.platform !== 'win32' && (status.mode & 0o077) !== 0) {
    throw new Error(`${label} is not private to its owner`);
  }
};

const writePrivateFileAtomically = ({ destination, bytes, temporaryLeaf }) => {
  const directory = path.dirname(destination);
  const temporary = path.join(directory, temporaryLeaf);
  if (path.dirname(temporary) !== directory || temporary === destination) {
    throw new Error('atomic private-file temporary path escaped its owned directory');
  }
  try {
    writePrivateFile(temporary, bytes);
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
};

const waitBriefly = (milliseconds) => {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waiter, 0, 0, milliseconds);
};

const parseExactJsonFile = (file, expectedKeys, label) => {
  assertPublishedFile(file, label);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...expectedKeys].sort().join('|')
  ) {
    throw new Error(`${label} has an unexpected schema`);
  }
  return value;
};

module.exports = {
  assertOwnedPrivateTemporaryFile,
  parseExactJsonFile,
  safeTemporaryLeaf,
  waitBriefly,
  writePrivateFile,
  writePrivateFileAtomically,
};
