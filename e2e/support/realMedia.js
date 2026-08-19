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

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { NATIVE_TOOLS_CACHE, REAL_MEDIA_CACHE } from './environment.js';

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
 * The newest real video anywhere in the cache, or `null` when nothing has been downloaded yet.
 *
 * Found rather than named, because the application names the file itself — from the title yt-dlp
 * resolved, which is how "Me at the zoo.mp4" appears rather than the video id. A harness that
 * assumed a name would silently stop finding it the day the product improved its naming.
 */
export const cachedRealVideo = () => {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.toLowerCase().endsWith('.mp4')) found.push(path);
    }
  };
  if (!existsSync(REAL_MEDIA_CACHE)) return null;
  walk(REAL_MEDIA_CACHE);
  if (found.length === 0) return null;
  return found.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
};

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
      + '  npx wdio run wdio.conf.js --spec ./journeys/urlToPreview.journey.js',
    );
  }

  execFileSync(ytDlp, [
    REAL_VIDEO.url,
    '--no-playlist',
    '--quiet',
    // The lowest rung that is a single self-contained MP4, so nothing has to be muxed afterwards.
    '--format', 'best[ext=mp4]/best',
    '--output', join(REAL_MEDIA_CACHE, `${REAL_VIDEO.id}.mp4`),
  ], { stdio: 'inherit', timeout: 300_000 });

  const downloaded = cachedRealVideo();
  if (downloaded === null) {
    throw new Error(`yt-dlp reported success but wrote no file into ${REAL_MEDIA_CACHE}`);
  }
  return downloaded;
};
