/**
 * The real video every media journey uses, and where a copy of it lives on disk.
 *
 * WHY A REAL URL AND NOT A FIXTURE. The journeys used to point at a local HTTP origin serving a
 * synthetic colour-bars MP4 and call that "the downloader protocol". It proved the decoder could
 * open a file the repository had generated, and nothing about what a customer actually does: no
 * yt-dlp, no format scan, no real container, no real codec, no network.
 *
 * WHY THIS PARTICULAR VIDEO. "Me at the zoo" is the first video published to YouTube. It is
 * nineteen seconds long, it carries no music licence, and it is the least likely video on the
 * platform to be deleted, made private or region-locked — which are the ways a real link turns a
 * product test into a flake. Short enough to fetch in seconds.
 *
 * WHAT IS ASSERTED ABOUT IT. Only what cannot drift: that the product resolved the URL, produced
 * playable media of about the right length, and named it. Its exact byte size and its format list
 * are yt-dlp's business and change without notice, so nothing here depends on them.
 */

/* global AbortSignal, Buffer, fetch, process */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  NATIVE_TOOLS_CACHE, REAL_MEDIA_CACHE, REPOSITORY_ROOT, SOURCE_SWITCH_MEDIA_CACHE,
} from './environment.js';

/**
 * Read-only rollback input from the pre-managed harness.
 *
 * Existing bytes are intentionally not migrated, copied, renamed, or deleted. A fresh acquisition
 * always writes REAL_MEDIA_CACHE; this fallback only keeps today's verified local workflows usable
 * while the external cache starts empty.
 */
export const LEGACY_REAL_MEDIA_CACHE = join(REPOSITORY_ROOT, 'target', 'e2e-real-media');

export const REAL_VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

/** What the product should end up with. Tolerances are wide on purpose. */
export const REAL_VIDEO = Object.freeze({
  url: REAL_VIDEO_URL,
  id: 'jNQXAC9IVRw',
  /** Nineteen seconds. Checked with a wide tolerance: a re-encode may trim a frame. */
  durationSeconds: 19,
  durationToleranceSeconds: 3,
  /** Part of the real title, matched loosely because the product may truncate or decorate it. */
  titleFragment: 'zoo',
});

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

const verifiedSourceSwitchBytes = (bytes) => (
  bytes.byteLength === SOURCE_SWITCH_VIDEO.bytes
  && createHash('sha256').update(bytes).digest('hex') === SOURCE_SWITCH_VIDEO.sha256
);

/** Download the pinned second source once, into its input-only cache. */
export const ensureSourceSwitchVideo = async () => {
  const destination = sourceSwitchVideoPath();
  if (existsSync(destination) && verifiedSourceSwitchBytes(readFileSync(destination))) {
    return destination;
  }
  rmSync(destination, { force: true });

  const response = await fetch(SOURCE_SWITCH_VIDEO.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`could not acquire the pinned source-switch video: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!verifiedSourceSwitchBytes(bytes)) {
    throw new Error(
      'the source-switch video no longer matches its pinned bytes: '
      + `${bytes.byteLength} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex')}`,
    );
  }

  mkdirSync(SOURCE_SWITCH_MEDIA_CACHE, { recursive: true });
  const temporary = join(
    SOURCE_SWITCH_MEDIA_CACHE,
    `.${SOURCE_SWITCH_VIDEO.filename}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return destination;
};

/**
 * The newest real video directly in the immutable input cache, or `null` when none exists.
 *
 * Found rather than named, because the application names the file itself — from the title yt-dlp
 * resolved, which is how "Me at the zoo.mp4" appears rather than the video id. A harness that
 * assumed a name would silently stop finding it the day the product improved its naming.
 */
const newestCachedVideo = (cacheRoot) => {
  if (!existsSync(cacheRoot)) return null;
  const found = readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mp4'))
    .map((entry) => join(cacheRoot, entry.name));
  if (found.length === 0) return null;
  return found.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
};

export const cachedRealVideo = (
  cacheRoot = REAL_MEDIA_CACHE,
  { legacyCacheRoot = cacheRoot === REAL_MEDIA_CACHE ? LEGACY_REAL_MEDIA_CACHE : null } = {},
) => newestCachedVideo(cacheRoot)
  ?? (legacyCacheRoot === null ? null : newestCachedVideo(legacyCacheRoot));

/** The yt-dlp the APPLICATION installed for itself, wherever its receipt put it. */
const installedYtDlp = () => {
  const roots = [join(NATIVE_TOOLS_CACHE, 'v1')];
  while (roots.length > 0) {
    const root = roots.pop();
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) roots.push(path);
      else if (entry.name.toLowerCase() === 'yt-dlp.exe') return path;
    }
  }
  return null;
};

/**
 * Make sure a real copy of the video is on disk, and return its path.
 *
 * WHY THE HARNESS MAY FETCH IT. The journeys that need media on disk are about what the application
 * does WITH a video — activation, preview, persistence, export — not about acquiring one. Acquiring
 * it is `urlToPreview`'s subject, and that journey drives the product's own downloader end to end.
 * This is the same video obtained the same way, cached so the other journeys do not each repeat a
 * network fetch that is not what they are testing.
 *
 * It uses the binary the APPLICATION installed from its reviewed delivery catalog, so the file is
 * produced by the same yt-dlp the product runs — not by whatever happens to be on the developer's
 * PATH, which is the substitution this whole harness exists to avoid.
 */
export const ensureRealVideo = () => {
  mkdirSync(REAL_MEDIA_CACHE, { recursive: true });
  const cached = cachedRealVideo();
  if (cached !== null) return cached;

  const ytDlp = installedYtDlp();
  if (ytDlp === null) {
    throw new Error(
       'No real video is cached and the application has not installed yt-dlp yet.\n'
       + 'Run the URL journey first — it installs the tools and downloads through the product:\n'
       + '  npm --prefix e2e run test:download',
    );
  }

  execFileSync(ytDlp, [
    REAL_VIDEO.url,
    '--no-playlist',
    '--quiet',
    // The lowest rung that is a single self-contained MP4, so nothing has to be muxed afterwards.
    '--format', 'best[ext=mp4]/best',
    '--output', join(REAL_MEDIA_CACHE, `${REAL_VIDEO.id}.mp4`),
  ], { stdio: 'inherit', timeout: 300_000, windowsHide: true });

  const downloaded = cachedRealVideo();
  if (downloaded === null) {
    throw new Error(`yt-dlp reported success but wrote no file into ${REAL_MEDIA_CACHE}`);
  }
  return downloaded;
};
