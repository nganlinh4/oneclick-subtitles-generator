// The managed external cache lanes and the persistent asset caches journeys junction in.

import { join, resolve } from 'node:path';

import {
  resolveDevelopmentCacheRoot as resolveDevelopmentCacheRootPure,
} from '../developmentCacheRoot.js';

export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..');

export const resolveDevelopmentCacheRoot = (options = {}) => resolveDevelopmentCacheRootPure({
  ...options,
  repositoryRoot: options.repositoryRoot ?? REPOSITORY_ROOT,
});
export const DEVELOPMENT_CACHE_ROOT = resolveDevelopmentCacheRoot();
export const E2E_APPLICATIONS_CACHE_ROOT = join(DEVELOPMENT_CACHE_ROOT, 'apps', 'e2e');
export const E2E_ASSET_CACHE_ROOT = join(DEVELOPMENT_CACHE_ROOT, 'assets', 'e2e');
export const EVIDENCE_CACHE_ROOT = join(DEVELOPMENT_CACHE_ROOT, 'evidence');
export const E2E_STAGING_ROOT = join(DEVELOPMENT_CACHE_ROOT, 'staging');

/**
 * Reviewed SUBTITLE fixtures a journey may hand to the application.
 *
 * Subtitle files only. There are no media fixtures any more: a journey that wants video downloads a
 * real one from a real URL, because a synthetic colour-bars clip proved the decoder could open a
 * synthetic colour-bars clip and nothing about what a customer actually plays. See `realMedia.js`.
 */
export const FIXTURE_ROOT = join(REPOSITORY_ROOT, 'e2e', 'fixtures', 'subtitles');

/**
 * Where the optional native tools live BETWEEN runs.
 *
 * FFmpeg, yt-dlp and Deno are downloaded from the reviewed delivery catalog on first use, and FFmpeg
 * alone is 110 MB. A customer installs them once and keeps them; re-downloading them for every
 * journey would be testing the installer over and over instead of testing the workflow, and would
 * put a third of a gigabyte of network traffic between a code change and its answer.
 *
 * So the directory is real, persistent, and OUTSIDE the disposable run root — junctioned in, rather
 * than provided by a new environment variable, because the application must keep resolving its tools
 * exactly where it resolves them for a customer. `nativeToolsInstall.journey.js` is the one that
 * starts from empty and proves the install itself.
 */
export const NATIVE_TOOLS_CACHE = join(E2E_ASSET_CACHE_ROOT, 'native-tools');

/**
 * Heavy local AI packages retained between isolated journeys.
 *
 * Faster-Whisper Turbo is a 4.56 GiB download and 6.73 GiB installed. Re-downloading it for every
 * clean database would test bandwidth rather than the customer workflow. The package store is
 * junctioned into an otherwise disposable root, exactly like a customer keeps an installed engine
 * while opening and closing projects. `nativeEngineInstall` owns the from-empty proof.
 */
export const ENGINE_PACKAGES_CACHE = join(E2E_ASSET_CACHE_ROOT, 'engine-packages');

/**
 * Where a real downloaded video is kept between runs. This cache is input-only; every journey
 * copies its selected media into its disposable run root and writes exports elsewhere in that root.
 *
 * The managed cache lease creates the owned asset lane before this child is used. The application
 * canonicalizes staged paths, so workflow setup creates this exact child before handing any path to
 * the application; a missing directory must remain a typed automation refusal, never a dialog.
 */
export const REAL_MEDIA_CACHE = join(E2E_ASSET_CACHE_ROOT, 'real-media');

/**
 * A second, visibly different real video used only by the main-preview source-switch journey.
 * Kept out of `REAL_MEDIA_CACHE` so newest-file discovery can never make unrelated journeys select
 * it instead of their reviewed YouTube source.
 */
export const SOURCE_SWITCH_MEDIA_CACHE = join(
  E2E_ASSET_CACHE_ROOT,
  'source-switch-media',
);

/** Offline-generated long-form speech/video used by the four-window ASR journey. */
export const FOUR_WINDOW_ASR_MEDIA_CACHE = join(E2E_ASSET_CACHE_ROOT, 'four-window-asr-media');

/**
 * Offline-generated, tiny-bitrate, hours-long synthetic media used by the long-media
 * resource-bound journey and its relaunch-recovery scenario. Long in TIME, not on disk: see
 * longSyntheticMediaFixture.js for the exact recipe and why duration (not bitrate) is what has
 * to be real here.
 */
export const LONG_SYNTHETIC_MEDIA_CACHE = join(E2E_ASSET_CACHE_ROOT, 'long-synthetic-media');
