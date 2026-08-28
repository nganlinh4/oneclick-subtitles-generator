import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

import { LONG_SYNTHETIC_MEDIA_CACHE, NATIVE_TOOLS_CACHE } from './environment.js';
import { withE2eApplicationLease } from './applicationLease.js';

/**
 * A wholly synthetic, hours-long, near-silent media file built offline with the reviewed
 * native-tools FFmpeg -- no network, no committed binary fixture.
 *
 * WHY SYNTHETIC AND NOT A LONGER REAL DOWNLOAD. Every other journey's media is a real download
 * because a synthetic clip only proves the decoder can open a file this repository generated. That
 * argument does not extend to DURATION: no reviewed, licence-clear public video runs for hours, and
 * downloading one would make a resource-bound proof depend on the network and on a multi-gigabyte
 * transfer. The claims this fixture exists to support are about real, product-owned bounds (waveform
 * point/byte caps, selectable-range clamping, job-recovery honesty) that a customer's actual pixels
 * cannot violate; a flat colour frame and a pure tone exercise the same real H.264/AAC container,
 * decode and native-pipeline code paths a customer's file does.
 *
 * WHY TWO HOURS. "60+ minutes" is the letter of the requirement; two hours (7200s) is chosen with
 * real margin on two different things at once: (1) it is unambiguously "long" for the waveform/
 * timeline-range assertions, and (2) native waveform generation decodes and aggregates PCM samples
 * proportional to DURATION, independent of the tiny encoded bitrate below -- 7200s at 8kHz is 57.6
 * million samples, real decode work that stays interceptable (as "still running") by ordinary
 * DOM/database polling even if the native decoder were an implausibly fast 500x realtime (7200s of
 * audio would still take ~14.4s to decode). That margin is what makes the cancellation and
 * relaunch-recovery proofs reliable without executing the harness to measure real throughput first.
 *
 * WHY TINY ON DISK. 64x36 (the smallest even H.264-legal frame this suite uses), 2fps, and a flat
 * grey colour source compress to almost nothing after the first keyframe; a 220Hz sine tone at
 * 8kHz/mono/16kbps AAC is likewise minimal real information. The result is a few-to-twenty-megabyte
 * file for two hours of real, playable, real-container media -- long in TIME, not on disk.
 */
export const LONG_SYNTHETIC_MEDIA = Object.freeze({
  filename: 'long-synthetic-media.mp4',
  durationSeconds: 7_200,
  durationToleranceSeconds: 2,
  width: 64,
  height: 36,
  frameRate: 2,
  audioFrequencyHz: 220,
  audioSampleRateHz: 8_000,
  audioBitrate: '16k',
});

const cacheDirectory = LONG_SYNTHETIC_MEDIA_CACHE;
const fixturePath = () => join(cacheDirectory, LONG_SYNTHETIC_MEDIA.filename);

const findReviewedMediaTool = (name) => {
  const pending = [join(NATIVE_TOOLS_CACHE, 'v1')];
  const matches = [];
  while (pending.length > 0) {
    const root = pending.pop();
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.name.toLowerCase() === name) matches.push(path);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `the reviewed native-tools cache must contain exactly one ${name}; found ${matches.length}`,
    );
  }
  return matches[0];
};

const probe = (path, ffprobe) => JSON.parse(execFileSync(ffprobe, [
  '-v', 'error',
  '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height',
  '-of', 'json',
  path,
], {
  encoding: 'utf8',
  timeout: 30_000,
  windowsHide: true,
}));

/**
 * Validate the semantic fixture contract independently of FFmpeg's byte-level encoder output. The
 * recipe is frozen; an output digest would only pin one FFmpeg build.
 */
export const validateLongSyntheticMediaProbe = (raw) => {
  const duration = Number(raw?.format?.duration);
  const size = Number(raw?.format?.size);
  const streams = Array.isArray(raw?.streams) ? raw.streams : [];
  const video = streams.find(({ codec_type: type }) => type === 'video');
  const audio = streams.find(({ codec_type: type }) => type === 'audio');
  if (!Number.isFinite(duration)
      || Math.abs(duration - LONG_SYNTHETIC_MEDIA.durationSeconds)
        > LONG_SYNTHETIC_MEDIA.durationToleranceSeconds
      || !Number.isSafeInteger(size)
      || size <= 0
      || video?.codec_name !== 'h264'
      || video.width !== LONG_SYNTHETIC_MEDIA.width
      || video.height !== LONG_SYNTHETIC_MEDIA.height
      || audio?.codec_name !== 'aac') {
    throw new Error(`the generated long synthetic media fixture is invalid: ${JSON.stringify(raw)}`);
  }
  return Object.freeze({ duration, size, videoCodec: video.codec_name, audioCodec: audio.codec_name });
};

const cachedFixtureIsValid = (path, ffprobe) => {
  try {
    validateLongSyntheticMediaProbe(probe(path, ffprobe));
    return true;
  } catch {
    return false;
  }
};

/**
 * Build the two-hour fixture from pure lavfi sources, without network access or any committed
 * binary input.
 */
const ensureLongSyntheticMediaWhileLeased = () => {
  const ffmpeg = findReviewedMediaTool('ffmpeg.exe');
  const ffprobe = join(dirname(ffmpeg), 'ffprobe.exe');
  if (!existsSync(ffprobe) || !statSync(ffprobe).isFile()) {
    throw new Error(`the reviewed FFmpeg package has no sibling ffprobe.exe: ${ffmpeg}`);
  }

  mkdirSync(cacheDirectory, { recursive: true });
  const destination = fixturePath();
  if (existsSync(destination) && cachedFixtureIsValid(destination, ffprobe)) return destination;
  rmSync(destination, { force: true });

  const temporary = join(
    cacheDirectory,
    `.${basename(destination)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp.mp4`,
  );
  try {
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', `color=c=gray:s=${LONG_SYNTHETIC_MEDIA.width}x${LONG_SYNTHETIC_MEDIA.height}:r=${LONG_SYNTHETIC_MEDIA.frameRate}`,
      '-f', 'lavfi', '-i', `sine=frequency=${LONG_SYNTHETIC_MEDIA.audioFrequencyHz}:sample_rate=${LONG_SYNTHETIC_MEDIA.audioSampleRateHz}`,
      '-map', '0:v:0', '-map', '1:a:0',
      '-t', String(LONG_SYNTHETIC_MEDIA.durationSeconds),
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p', '-r', String(LONG_SYNTHETIC_MEDIA.frameRate), '-g', '20',
      '-c:a', 'aac', '-b:a', LONG_SYNTHETIC_MEDIA.audioBitrate,
      '-ar', String(LONG_SYNTHETIC_MEDIA.audioSampleRateHz), '-ac', '1',
      '-map_metadata', '-1', '-movflags', '+faststart', '-shortest',
      temporary,
    ], { stdio: 'inherit', timeout: 600_000, windowsHide: true });
    validateLongSyntheticMediaProbe(probe(temporary, ffprobe));
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return destination;
};

export const ensureLongSyntheticMedia = ({
  withApplicationLease = withE2eApplicationLease,
} = {}) => withApplicationLease(ensureLongSyntheticMediaWhileLeased);

/**
 * Build and stage the asset under an application lease the caller ALREADY holds.
 *
 * A scenario runs inside `withScenarioLeases`, whose live application lease covers the asset lane
 * for its whole run; acquiring here again refuses against that same live hold. The caller proves the
 * hold with the serialized inherited-application lease the scenario distributes to its worker
 * processes, matching `stagedFourWindowAsrVideo`'s contract exactly.
 */
export const stagedLongSyntheticMedia = ({ inheritedApplication, stage }) => {
  if (typeof inheritedApplication !== 'string' || inheritedApplication.length === 0) {
    throw new Error("the long synthetic media fixture requires the holder's serialized application lease");
  }
  return stage(ensureLongSyntheticMediaWhileLeased());
};
