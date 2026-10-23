// Media-file discovery, ffprobe metadata, audio energy and single-frame FFmpeg operations.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, statSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import { ffmpeg, ffprobe } from './nativeMediaTools.js';

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
  '-show_entries', 'format=duration,size,format_name:'
    + 'stream=index,codec_type,codec_name,width,height,duration,duration_ts,time_base,start_time,'
    + 'avg_frame_rate,r_frame_rate,sample_rate,channels',
  '-of', 'json',
  path,
], { encoding: 'utf8', timeout: 60_000, windowsHide: true }));

export const parseVolumeDetect = (output) => {
  const text = String(output ?? '');
  // FFmpeg 8 flushes every volumedetect instance it constructed, and graph setup can construct one
  // that never receives samples: its `n_samples: 0` line precedes the real measurement. The LAST
  // occurrence of each metric is the final flush of the instance that actually saw the audio.
  const parseLevel = (name) => {
    const matches = [...text.matchAll(new RegExp(`${name}:\\s*(-?inf|-?\\d+(?:\\.\\d+)?)\\s*dB`, 'giu'))];
    const match = matches.at(-1);
    if (match === undefined) return null;
    return /^-inf$/iu.test(match[1]) ? Number.NEGATIVE_INFINITY : Number(match[1]);
  };
  const sampleMatch = [...text.matchAll(/n_samples:\s*(\d+)/giu)].at(-1);
  const samples = sampleMatch === undefined ? null : Number(sampleMatch[1]);
  const meanVolumeDb = parseLevel('mean_volume');
  const peakVolumeDb = parseLevel('max_volume');
  if (!Number.isSafeInteger(samples) || samples <= 0
      || meanVolumeDb === null || peakVolumeDb === null) {
    throw new Error('FFmpeg volumedetect exposed no bounded audio-energy result');
  }
  return Object.freeze({ samples, meanVolumeDb, peakVolumeDb });
};

/** Measure decoded audio energy, not merely the presence of a plausible ffprobe stream header. */
export const measureAudioSignal = (path) => {
  const result = spawnSync(ffmpeg(), [
    '-v', 'info', '-nostdin', '-i', path, '-map', '0:a:0',
    '-af', 'volumedetect', '-f', 'null', '-',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, windowsHide: true });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`could not measure audio energy in ${basename(path)} (exit ${result.status ?? 'none'})`);
  }
  return parseVolumeDetect(output);
};

export const extractFrame = (mediaPath, seconds, outputPath) => {
  mkdirSync(dirname(outputPath), { recursive: true });
  execFileSync(ffmpeg(), [
    '-v', 'error', '-y', '-ss', String(seconds), '-i', mediaPath,
    '-frames:v', '1', '-pix_fmt', 'rgba', outputPath,
  ], { stdio: 'pipe', timeout: 60_000, windowsHide: true });
};

export const compareFrames = (referencePath, candidatePath) => {
  const result = spawnSync(ffmpeg(), [
    '-v', 'info', '-i', referencePath, '-i', candidatePath,
    '-filter_complex', '[1:v][0:v]scale2ref[scaled][reference];[reference][scaled]ssim',
    '-f', 'null', '-',
  ], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, windowsHide: true,
  });
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

export const cropSubtitleRegion = (inputPath, outputPath, { bottomRatio = 0.28 } = {}) => {
  mkdirSync(dirname(outputPath), { recursive: true });
  const topRatio = 1.0 - bottomRatio;
  execFileSync(ffmpeg(), [
    '-v', 'error', '-y', '-i', inputPath,
    '-vf', `crop=in_w:in_h*${bottomRatio}:0:in_h*${topRatio}`,
    '-frames:v', '1', outputPath,
  ], { stdio: 'pipe', timeout: 60_000, windowsHide: true });
};
