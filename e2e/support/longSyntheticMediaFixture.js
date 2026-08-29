import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  rmSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';

import { LONG_SYNTHETIC_MEDIA_CACHE, NATIVE_TOOLS_CACHE } from './environment.js';
import { assertLiveE2eAssetLease } from './applicationLease.js';
import {
  cachedManagedFixture, managedFixtureIdentity, pruneManagedFixtureOrphans,
  publishManagedFixture, reviewedToolProvenance,
} from './managedFixturePublication.js';
import { prepareManagedAssetCache, runSupervisedAssetTool } from './managedAssetCache.js';
import { resolveVerifiedNativeToolRoles } from './nativeToolsOracle.js';

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

export const LONG_SYNTHETIC_RECIPE = Object.freeze({
  source: Object.freeze({
    video: `color=c=gray:s=${LONG_SYNTHETIC_MEDIA.width}x${LONG_SYNTHETIC_MEDIA.height}:r=${LONG_SYNTHETIC_MEDIA.frameRate}`,
    audio: `sine=frequency=${LONG_SYNTHETIC_MEDIA.audioFrequencyHz}:sample_rate=${LONG_SYNTHETIC_MEDIA.audioSampleRateHz}`,
  }),
  durationSeconds: LONG_SYNTHETIC_MEDIA.durationSeconds,
  video: Object.freeze({
    codec: 'libx264', preset: 'veryfast', tune: 'stillimage', pixelFormat: 'yuv420p',
    frameRate: LONG_SYNTHETIC_MEDIA.frameRate, keyframeInterval: 20,
  }),
  audio: Object.freeze({
    codec: 'aac', bitrate: LONG_SYNTHETIC_MEDIA.audioBitrate,
    sampleRateHz: LONG_SYNTHETIC_MEDIA.audioSampleRateHz, channels: 1,
  }),
  metadata: 'stripped',
  movflags: '+faststart',
  termination: 'shortest',
});

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

const normalizedProbe = (raw) => {
  const semantic = validateLongSyntheticMediaProbe(raw);
  return Object.freeze({
    durationSeconds: semantic.duration,
    sizeBytes: semantic.size,
    videoCodec: semantic.videoCodec,
    audioCodec: semantic.audioCodec,
    width: LONG_SYNTHETIC_MEDIA.width,
    height: LONG_SYNTHETIC_MEDIA.height,
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
  kind: 'long-synthetic-media',
  recipe: LONG_SYNTHETIC_RECIPE,
  tools: reviewedToolProvenance({
    storeRoot: NATIVE_TOOLS_CACHE,
    roles: { ffmpeg, ffprobe },
  }),
});

/**
 * Build the two-hour fixture from pure lavfi sources, without network access or any committed
 * binary input.
 */
const ensureLongSyntheticMediaWhileLeased = (applicationLease) => {
  prepareManagedAssetCache({ applicationLease, cacheRoot: cacheDirectory });
  const { ffmpeg, ffprobe } = resolveVerifiedNativeToolRoles({
    storeRoot: NATIVE_TOOLS_CACHE, tool: 'media-tools', roles: ['ffmpeg', 'ffprobe'],
  });
  const expectedFixture = fixtureAuthority({ ffmpeg, ffprobe });
  const cached = cachedManagedFixture({
    cacheRoot: cacheDirectory,
    expectedFixture,
    originalName: LONG_SYNTHETIC_MEDIA.filename,
    validateProbe: validateReceiptProbe,
  });
  if (cached !== null) return cached.path;
  // Resolving and hashing the reviewed native-tool tree can be slow. Revalidate immediately before
  // the first cache mutation rather than relying on the check made before that work began.
  assertLiveE2eAssetLease(applicationLease);

  const temporary = join(
    cacheDirectory,
    `.${basename(LONG_SYNTHETIC_MEDIA.filename)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp.mp4`,
  );
  try {
    runSupervisedAssetTool({ applicationLease, command: ffmpeg, args: [
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
    ] });
    const verifiedProbe = normalizedProbe(probe(temporary, ffprobe));
    // ffprobe is another external process. A killed/reclaimed owner must never publish after it.
    assertLiveE2eAssetLease(applicationLease);
    const destination = publishManagedFixture({
      assertStillLive: () => assertLiveE2eAssetLease(applicationLease),
      cacheRoot: cacheDirectory,
      candidate: temporary,
      expectedFixture,
      originalName: LONG_SYNTHETIC_MEDIA.filename,
      probe: verifiedProbe,
      validateProbe: validateReceiptProbe,
    });
    pruneManagedFixtureOrphans({
      assertStillLive: () => assertLiveE2eAssetLease(applicationLease),
      cacheRoot: cacheDirectory,
      originalName: LONG_SYNTHETIC_MEDIA.filename,
      selectedPath: destination,
    });
    return destination;
  } finally {
    // If authority went stale, even rollback is a cache mutation. Leave the unreferenced temporary
    // file for the next live lease owner's bounded cache maintenance instead.
    try {
      assertLiveE2eAssetLease(applicationLease);
      rmSync(temporary, { force: true });
    } catch {
      // Deliberately mutation-free after stale authority.
    }
  }
};

export const ensureLongSyntheticMedia = ({ applicationLease }) => {
  return ensureLongSyntheticMediaWhileLeased(applicationLease);
};

/** Read-only child/config proof after the outer lease owner has prepared the fixture. */
export const verifiedLongSyntheticMedia = () => {
  const { ffmpeg, ffprobe } = resolveVerifiedNativeToolRoles({
    storeRoot: NATIVE_TOOLS_CACHE, tool: 'media-tools', roles: ['ffmpeg', 'ffprobe'],
  });
  const cached = cachedManagedFixture({
    cacheRoot: cacheDirectory,
    expectedFixture: fixtureAuthority({ ffmpeg, ffprobe }),
    originalName: LONG_SYNTHETIC_MEDIA.filename,
    validateProbe: validateReceiptProbe,
  });
  if (cached === null) {
    throw new Error('the outer lease owner did not prepare valid long synthetic media');
  }
  return cached.path;
};

/**
 * Build and stage the asset under an application lease the caller ALREADY holds.
 *
 * A scenario runs inside `withScenarioLeases`, whose live application lease covers the asset lane
 * for its whole run; acquiring here again refuses against that same live hold. The caller proves the
 * hold with the exact live branded application lease. Only the outer owner stages the resulting
 * file into its disposable run root; worker processes receive no persistent-cache authority.
 */
export const stagedLongSyntheticMedia = ({ applicationLease, stage }) => {
  return stage(ensureLongSyntheticMedia({ applicationLease }));
};
