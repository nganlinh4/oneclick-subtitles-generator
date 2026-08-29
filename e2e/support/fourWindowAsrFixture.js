import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  readFileSync, rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

import {
  FOUR_WINDOW_ASR_MEDIA_CACHE, NATIVE_TOOLS_CACHE, REPOSITORY_ROOT,
} from './environment.js';
import { assertLiveE2eAssetLease } from './applicationLease.js';
import {
  assertOrdinaryFixtureFile, cachedManagedFixture, managedFixtureIdentity,
  pruneManagedFixtureOrphans, publishManagedFixture, reviewedToolProvenance,
} from './managedFixturePublication.js';
import { prepareManagedAssetCache, runSupervisedAssetTool } from './managedAssetCache.js';
import { resolveVerifiedNativeToolRoles } from './nativeToolsOracle.js';

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

export const FOUR_WINDOW_ASR_RECIPE = Object.freeze({
  repeats: FOUR_WINDOW_ASR_FIXTURE.repeats,
  durationSeconds: FOUR_WINDOW_ASR_FIXTURE.durationSeconds,
  video: Object.freeze({
    source: `color=c=black:s=${FOUR_WINDOW_ASR_FIXTURE.width}x${FOUR_WINDOW_ASR_FIXTURE.height}:r=5`,
    codec: 'libx264', preset: 'veryfast', tune: 'stillimage', pixelFormat: 'yuv420p',
    frameRate: 5, keyframeInterval: 25,
  }),
  audio: Object.freeze({ codec: 'aac', bitrate: '64k', sampleRateHz: 16_000, channels: 1 }),
  metadata: 'stripped',
  movflags: '+faststart',
  termination: 'shortest',
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const assertFrozenSource = () => {
  assertOrdinaryFixtureFile(SOURCE.path, {
    label: 'tracked real-speech source', parent: dirname(SOURCE.path),
  });
  const bytes = readFileSync(SOURCE.path);
  if (bytes.byteLength !== SOURCE.bytes || sha256(bytes) !== SOURCE.sha256) {
    throw new Error(
      'the tracked real-speech source changed; review and re-pin it before rebuilding the four-window fixture',
    );
  }
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

const normalizedProbe = (raw) => {
  const semantic = validateFourWindowAsrProbe(raw);
  return Object.freeze({
    durationSeconds: semantic.duration,
    sizeBytes: semantic.size,
    videoCodec: semantic.videoCodec,
    audioCodec: semantic.audioCodec,
    width: FOUR_WINDOW_ASR_FIXTURE.width,
    height: FOUR_WINDOW_ASR_FIXTURE.height,
  });
};

const validateReceiptProbe = (value) => normalizedProbe({
  format: { duration: value?.durationSeconds, size: value?.sizeBytes },
  streams: [
    {
      codec_type: 'video', codec_name: value?.videoCodec,
      width: value?.width, height: value?.height,
    },
    { codec_type: 'audio', codec_name: value?.audioCodec },
  ],
});

const fixtureAuthority = ({ ffmpeg, ffprobe }) => managedFixtureIdentity({
  kind: 'four-window-asr-media',
  recipe: FOUR_WINDOW_ASR_RECIPE,
  source: Object.freeze({
    filename: basename(SOURCE.path),
    sizeBytes: SOURCE.bytes,
    sha256: SOURCE.sha256,
    durationSeconds: SOURCE.durationSeconds,
  }),
  tools: reviewedToolProvenance({
    storeRoot: NATIVE_TOOLS_CACHE,
    roles: { ffmpeg, ffprobe },
  }),
});

/**
 * Build a compact long-form fixture from tracked real speech, without network access.
 *
 * Ten decoded repetitions of a 20.4-second AMI meeting excerpt produce 204 seconds. A one-minute
 * customer setting therefore creates exactly four native ASR jobs. The black video track is only
 * the minimum real H.264 surface needed to exercise the ordinary video-import UI; ASR receives the
 * original speech samples re-encoded as mono AAC.
 */
const ensureFourWindowAsrVideoWhileLeased = (applicationLease) => {
  assertFrozenSource();
  prepareManagedAssetCache({ applicationLease, cacheRoot: cacheDirectory });
  const { ffmpeg, ffprobe } = resolveVerifiedNativeToolRoles({
    storeRoot: NATIVE_TOOLS_CACHE, tool: 'media-tools', roles: ['ffmpeg', 'ffprobe'],
  });
  const expectedFixture = fixtureAuthority({ ffmpeg, ffprobe });
  const cached = cachedManagedFixture({
    cacheRoot: cacheDirectory,
    expectedFixture,
    originalName: FOUR_WINDOW_ASR_FIXTURE.filename,
    validateProbe: validateReceiptProbe,
  });
  if (cached !== null) return cached.path;
  // The native-tool receipt walk hashes a large installed tree. Never mutate from the authority
  // check made before that work if the owning lease has since become stale.
  assertLiveE2eAssetLease(applicationLease);
  const temporary = join(
    cacheDirectory,
    `.${basename(FOUR_WINDOW_ASR_FIXTURE.filename)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp.mp4`,
  );
  try {
    runSupervisedAssetTool({ applicationLease, command: ffmpeg, args: [
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
    ] });
    const verifiedProbe = normalizedProbe(probe(temporary, ffprobe));
    assertLiveE2eAssetLease(applicationLease);
    const destination = publishManagedFixture({
      assertStillLive: () => assertLiveE2eAssetLease(applicationLease),
      cacheRoot: cacheDirectory,
      candidate: temporary,
      expectedFixture,
      originalName: FOUR_WINDOW_ASR_FIXTURE.filename,
      probe: verifiedProbe,
      validateProbe: validateReceiptProbe,
    });
    pruneManagedFixtureOrphans({
      assertStillLive: () => assertLiveE2eAssetLease(applicationLease),
      cacheRoot: cacheDirectory,
      originalName: FOUR_WINDOW_ASR_FIXTURE.filename,
      selectedPath: destination,
    });
    return destination;
  } finally {
    try {
      assertLiveE2eAssetLease(applicationLease);
      rmSync(temporary, { force: true });
    } catch {
      // A stale owner performs no rollback mutation; maintenance under a fresh lease removes it.
    }
  }
};

export const ensureFourWindowAsrVideo = ({ applicationLease }) => {
  return ensureFourWindowAsrVideoWhileLeased(applicationLease);
};

/**
 * Build and stage the asset under an application lease the caller ALREADY holds.
 *
 * A scenario runs inside `withScenarioLeases`, whose live application lease covers the asset lane
 * for its whole run; acquiring here again refuses against that same live hold. The caller proves
 * the hold with the serialized inherited-application lease the scenario distributes to its worker
 * processes, so the asset stays protected until the staged copy exists in the disposable root.
 */
export const stagedFourWindowAsrVideo = ({ applicationLease, stage }) => {
  return stage(ensureFourWindowAsrVideo({ applicationLease }));
};
