import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import { NATIVE_TOOLS_CACHE } from './environment.js';

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

const ffprobe = () => findTool('ffprobe.exe');
const ffmpeg = () => findTool('ffmpeg.exe');

export const newestMediaFile = (directory, existing = new Set()) => {
  if (!existsSync(directory)) return null;
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(directory, entry.name))
    .filter((path) => !existing.has(path))
    .filter((path) => ['.mp4', '.mkv', '.mov', '.webm'].includes(extname(path).toLowerCase()))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return candidates[0] ?? null;
};

export const listMediaFiles = (directory) => new Set(
  existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(directory, entry.name))
    : [],
);

export const probeMedia = (path) => JSON.parse(execFileSync(ffprobe(), [
  '-v', 'error',
  '-show_entries', 'format=duration,size,format_name:stream=index,codec_type,codec_name,width,height',
  '-of', 'json',
  path,
], { encoding: 'utf8', timeout: 60_000 }));

export const saveNativePreviewFrame = async (path) => {
  const frame = await browser.execute(() => {
    const image = document.querySelector('.video-preview .native-composited-frame');
    return image === null ? null : { src: image.src, layer: image.dataset.layer ?? null };
  });
  if (frame === null || frame.layer !== 'composited') {
    throw new Error(`the editor exposed no composited preview frame: ${JSON.stringify(frame)}`);
  }
  const response = await fetch(frame.src);
  if (!response.ok) throw new Error(`the native frame capability returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { ...frame, bytes: bytes.length };
};

export const extractFrame = (mediaPath, seconds, outputPath) => {
  mkdirSync(dirname(outputPath), { recursive: true });
  execFileSync(ffmpeg(), [
    '-v', 'error', '-y', '-ss', String(seconds), '-i', mediaPath,
    '-frames:v', '1', '-pix_fmt', 'rgba', outputPath,
  ], { stdio: 'pipe', timeout: 60_000 });
};

export const compareFrames = (referencePath, candidatePath) => {
  const result = spawnSync(ffmpeg(), [
    '-v', 'info', '-i', referencePath, '-i', candidatePath,
    '-lavfi', 'ssim', '-f', 'null', '-',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = /SSIM[^\n]*All:([0-9.]+)/.exec(output);
  if (result.error !== undefined || result.status !== 0 || match === null) {
    throw new Error(
      `could not compare ${basename(referencePath)} and ${basename(candidatePath)} `
      + `(exit ${result.status ?? 'none'}): ${output}`,
    );
  }
  return Number(match[1]);
};
