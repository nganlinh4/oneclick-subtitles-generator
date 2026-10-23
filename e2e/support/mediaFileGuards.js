// Ordinary-file, redirect and content-identity checks for cached real media.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

export const sha256File = (path) => {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, 'r');
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest('hex');
};

export const samePath = (left, right) => (
  process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
);

export const assertOrdinaryFile = (path, label) => {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} is not one ordinary singly-linked file`);
  }
  if (!samePath(realpathSync.native(path), path)) {
    throw new Error(`${label} crosses a redirected path`);
  }
  return metadata;
};

export const assertManagedCacheRoot = (cacheRoot) => {
  const metadata = lstatSync(cacheRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('the real-media cache root is not one ordinary directory');
  }
  if (!samePath(realpathSync.native(cacheRoot), cacheRoot)) {
    throw new Error('the real-media cache root crosses a redirected path');
  }
  return cacheRoot;
};
