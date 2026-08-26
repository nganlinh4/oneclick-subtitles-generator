import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

import {
  FOUR_WINDOW_ASR_MEDIA_CACHE, NATIVE_TOOLS_CACHE, REPOSITORY_ROOT,
} from './environment.js';
import { withE2eApplicationLease } from './applicationLease.js';

const SOURCE = Object.freeze({
  path: join(
    REPOSITORY_ROOT,
    'tests',
    'subtitle-benchmark',
    'fixtures',
    'en-ami-meeting.flac',
  ),
  bytes: 203_077,
  sha256: '37cb02502a3116303c6d7295318a8795899a665da5602ada6d114ac5087dcfc2',
  durationSeconds: 20.4,
});

export const FOUR_WINDOW_ASR_FIXTURE = Object.freeze({
  filename: 'asr-four-windows-real-speech.mp4',
  source: SOURCE,
  repeats: 10,
  durationSeconds: 204,
  durationToleranceSeconds: 0.2,
  maxRequestSeconds: 60,
  expectedWindowCount: 4,
  width: 320,
  height: 180,
});

const cacheDirectory = FOUR_WINDOW_ASR_MEDIA_CACHE;
const fixturePath = () => join(cacheDirectory, FOUR_WINDOW_ASR_FIXTURE.filename);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const assertFrozenSource = () => {
  const bytes = readFileSync(SOURCE.path);
  if (bytes.byteLength !== SOURCE.bytes || sha256(bytes) !== SOURCE.sha256) {
    throw new Error(
      'the tracked real-speech source changed; review and re-pin it before rebuilding the four-window fixture',
    );
  }
};

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
 * Validate the semantic fixture contract independently of FFmpeg's byte-level encoder output.
 * The input speech bytes and recipe are frozen; an output digest would only pin one FFmpeg build.
 */
export const validateFourWindowAsrProbe = (raw) => {
  const duration = Number(raw?.format?.duration);
  const size = Number(raw?.format?.size);
  const streams = Array.isArray(raw?.streams) ? raw.streams : [];
  const video = streams.find(({ codec_type: type }) => type === 'video');
  const audio = streams.find(({ codec_type: type }) => type === 'audio');
  if (!Number.isFinite(duration)
      || Math.abs(duration - FOUR_WINDOW_ASR_FIXTURE.durationSeconds)
        > FOUR_WINDOW_ASR_FIXTURE.durationToleranceSeconds
      || !Number.isSafeInteger(size)
      || size <= 0
      || video?.codec_name !== 'h264'
      || video.width !== FOUR_WINDOW_ASR_FIXTURE.width
      || video.height !== FOUR_WINDOW_ASR_FIXTURE.height
      || audio?.codec_name !== 'aac'
      || Math.ceil(duration / FOUR_WINDOW_ASR_FIXTURE.maxRequestSeconds)
        !== FOUR_WINDOW_ASR_FIXTURE.expectedWindowCount) {
    throw new Error(`the generated four-window ASR fixture is invalid: ${JSON.stringify(raw)}`);
  }
  return Object.freeze({ duration, size, videoCodec: video.codec_name, audioCodec: audio.codec_name });
};

const cachedFixtureIsValid = (path, ffprobe) => {
  try {
    validateFourWindowAsrProbe(probe(path, ffprobe));
    return true;
  } catch {
    return false;
  }
};

/**
 * Build a compact long-form fixture from tracked real speech, without network access.
 *
 * Ten decoded repetitions of a 20.4-second AMI meeting excerpt produce 204 seconds. A one-minute
 * customer setting therefore creates exactly four native ASR jobs. The black video track is only
 * the minimum real H.264 surface needed to exercise the ordinary video-import UI; ASR receives the
 * original speech samples re-encoded as mono AAC.
 */
const ensureFourWindowAsrVideoWhileLeased = () => {
  assertFrozenSource();
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
      '-stream_loop', String(FOUR_WINDOW_ASR_FIXTURE.repeats - 1),
      '-i', SOURCE.path,
      '-f', 'lavfi', '-i', `color=c=black:s=${FOUR_WINDOW_ASR_FIXTURE.width}x${FOUR_WINDOW_ASR_FIXTURE.height}:r=5`,
      '-map', '1:v:0', '-map', '0:a:0',
      '-t', String(FOUR_WINDOW_ASR_FIXTURE.durationSeconds),
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p', '-r', '5', '-g', '25',
      '-c:a', 'aac', '-b:a', '64k', '-ar', '16000', '-ac', '1',
      '-map_metadata', '-1', '-movflags', '+faststart', '-shortest',
      temporary,
    ], { stdio: 'inherit', timeout: 300_000, windowsHide: true });
    validateFourWindowAsrProbe(probe(temporary, ffprobe));
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return destination;
};

export const ensureFourWindowAsrVideo = ({
  withApplicationLease = withE2eApplicationLease,
} = {}) => withApplicationLease(ensureFourWindowAsrVideoWhileLeased);

/**
 * Build and stage the asset under an application lease the caller ALREADY holds.
 *
 * A scenario runs inside `withScenarioLeases`, whose live application lease covers the asset lane
 * for its whole run; acquiring here again refuses against that same live hold. The caller proves
 * the hold with the serialized inherited-application lease the scenario distributes to its worker
 * processes, so the asset stays protected until the staged copy exists in the disposable root.
 */
export const stagedFourWindowAsrVideo = ({ inheritedApplication, stage }) => {
  if (typeof inheritedApplication !== 'string' || inheritedApplication.length === 0) {
    throw new Error("the four-window fixture requires the holder's serialized application lease");
  }
  return stage(ensureFourWindowAsrVideoWhileLeased());
};
