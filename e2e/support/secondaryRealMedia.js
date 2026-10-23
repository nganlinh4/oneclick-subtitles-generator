// The two secondary reviewed videos: the Sintel source-switch trailer (downloaded once under the
// asset lease) and the committed download-identity clip.

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { assertLiveE2eAssetLease } from './applicationLease.js';
import { REPOSITORY_ROOT, SOURCE_SWITCH_MEDIA_CACHE } from './environment.js';
import {
  assertManagedCacheRoot, assertOrdinaryFile, samePath, sha256File,
} from './mediaFileGuards.js';

const require = createRequire(import.meta.url);
const { runSupervisedSync } = require('../../scripts/windows-job-supervisor.js');

/**
 * A durable, open movie trailer that makes stale-source pixels measurable.
 *
 * The primary fixture is 4:3, about nineteen seconds and filmed at a zoo. Sintel is 16:9, about
 * fifty-two seconds and animated, so duration, dimensions and compositor pixels independently name
 * which source is on screen. W3C has hosted this exact Blender Foundation trailer since 2010. The
 * pinned digest makes a changed/error response a harness failure rather than an accidental new
 * fixture. Acquiring it is setup for a source-switch test, not a substitute for product download
 * coverage; `urlToPreview` separately drives the application's own downloader.
 */
export const SOURCE_SWITCH_VIDEO = Object.freeze({
  url: 'https://media.w3.org/2010/05/sintel/trailer.mp4',
  filename: 'sintel-trailer.mp4',
  sha256: 'b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254',
  bytes: 4_372_373,
  durationSeconds: 52.208333,
  durationToleranceSeconds: 1,
  width: 854,
  height: 480,
});

/**
 * A small real Vietnamese speech clip already reviewed and committed for the subtitle benchmark.
 * The download identity journey serves it as source B from its exact local capability origin. That
 * journey remains deterministic and offline once Sintel is cached; the separate `urlToPreview`
 * journey continues to own proof that the current downloader works against the real network.
 */
export const DOWNLOAD_IDENTITY_VIDEO = Object.freeze({
  filename: 'vi-fleurs-container.mp4',
  sha256: '96ca49c8cc44b2899c7c24c7d29a6a25b75c30f7f8dd2b3a3d7dd31dcbcfcc96',
  bytes: 70_155,
  durationSeconds: 8.46,
  durationToleranceSeconds: 0.25,
  width: 320,
  height: 180,
});

export const verifiedDownloadIdentityVideo = () => {
  const path = join(
    REPOSITORY_ROOT,
    'tests',
    'subtitle-benchmark',
    'fixtures',
    DOWNLOAD_IDENTITY_VIDEO.filename,
  );
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== DOWNLOAD_IDENTITY_VIDEO.bytes
      || sha256 !== DOWNLOAD_IDENTITY_VIDEO.sha256) {
    throw new Error(
      `the committed download-identity video changed: ${bytes.byteLength} bytes, sha256 ${sha256}`,
    );
  }
  return path;
};

const sourceSwitchVideoPath = () => join(SOURCE_SWITCH_MEDIA_CACHE, SOURCE_SWITCH_VIDEO.filename);

export const cachedSourceSwitchVideo = () => {
  const path = sourceSwitchVideoPath();
  try {
    const metadata = assertOrdinaryFile(path, 'source-switch media');
    return metadata.size === SOURCE_SWITCH_VIDEO.bytes
      && sha256File(path) === SOURCE_SWITCH_VIDEO.sha256 ? path : null;
  } catch {
    return null;
  }
};

const SOURCE_SWITCH_DOWNLOAD_SCRIPT = String.raw`
import { open } from 'node:fs/promises';
const [url, output, expectedRaw] = process.argv.slice(1);
const expected = Number(expectedRaw);
const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
if (!response.ok || response.body === null) throw new Error('HTTP ' + response.status);
const file = await open(output, 'wx', 0o600);
let total = 0;
try {
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > expected) throw new Error('source-switch response exceeded its pinned size');
    await file.write(chunk);
  }
  if (total !== expected) throw new Error('source-switch response length differed');
  await file.sync();
} finally {
  await file.close();
}
`;

/** Download the pinned second source once, into its input-only cache. */
export const ensureSourceSwitchVideo = ({ applicationLease }) => {
  const assetRoot = assertLiveE2eAssetLease(applicationLease);
  if (!samePath(resolve(SOURCE_SWITCH_MEDIA_CACHE, '..'), assetRoot)) {
    throw new Error('the source-switch cache is not covered by the live asset lease');
  }
  const destination = sourceSwitchVideoPath();
  const cached = cachedSourceSwitchVideo();
  if (cached !== null) return cached;

  mkdirSync(SOURCE_SWITCH_MEDIA_CACHE, { recursive: true });
  assertManagedCacheRoot(SOURCE_SWITCH_MEDIA_CACHE);
  const temporary = join(
    SOURCE_SWITCH_MEDIA_CACHE,
    `.${SOURCE_SWITCH_VIDEO.filename}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    const result = runSupervisedSync({
      command: process.execPath,
      args: [
        '--input-type=module', '--eval', SOURCE_SWITCH_DOWNLOAD_SCRIPT,
        SOURCE_SWITCH_VIDEO.url, temporary, String(SOURCE_SWITCH_VIDEO.bytes),
      ],
      cwd: REPOSITORY_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
      ownerProcessId: process.pid,
      managedPaths: applicationLease.managedPaths,
    });
    if (
      result.error
      || result.status !== 0
      || (result.stdout?.length ?? 0) > 4096
      || (result.stderr?.length ?? 0) > 4096
    ) {
      throw result.error ?? new Error(
        `the supervised source-switch download failed with exit ${result.status}: `
        + String(result.stderr ?? '').slice(0, 4096),
      );
    }
    const metadata = assertOrdinaryFile(temporary, 'source-switch download');
    if (metadata.size !== SOURCE_SWITCH_VIDEO.bytes
        || sha256File(temporary) !== SOURCE_SWITCH_VIDEO.sha256) {
      throw new Error('the source-switch download does not match its pinned identity');
    }
    assertLiveE2eAssetLease(applicationLease);
    rmSync(destination, { force: true });
    renameSync(temporary, destination);
  } finally {
    try {
      assertLiveE2eAssetLease(applicationLease);
      rmSync(temporary, { force: true });
    } catch {
      // Cache reclamation or marker replacement revokes rollback authority as well as publishing.
    }
  }
  return destination;
};
