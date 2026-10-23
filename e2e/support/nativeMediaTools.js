// Locates the managed FFmpeg/FFprobe the E2E native-tools cache installed: never a system binary.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { resolveDevelopmentCacheRoot } from './developmentCacheRoot.js';

const REPOSITORY_ROOT = join(import.meta.dirname, '..', '..');
const NATIVE_TOOLS_CACHE = join(
  resolveDevelopmentCacheRoot({ repositoryRoot: REPOSITORY_ROOT }),
  'assets',
  'e2e',
  'native-tools',
);

const findTool = (filename) => {
  const matches = [];
  const pending = [NATIVE_TOOLS_CACHE];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.name.toLowerCase() === filename.toLowerCase()) matches.push(path);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`expected one installed ${filename}, found ${matches.length}: ${matches.join(', ')}`);
  }
  return matches[0];
};

export const ffprobe = () => findTool('ffprobe.exe');
export const ffmpeg = () => findTool('ffmpeg.exe');
