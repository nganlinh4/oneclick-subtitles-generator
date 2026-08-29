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

/* global Buffer, process */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  readSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import {
  basename, dirname, isAbsolute, join, relative, resolve, sep,
} from 'node:path';

import {
  E2E_ASSET_CACHE_ROOT, NATIVE_TOOLS_CACHE, REAL_MEDIA_CACHE, REPOSITORY_ROOT,
  SOURCE_SWITCH_MEDIA_CACHE,
} from './environment.js';
import { assertLiveE2eAssetLease } from './applicationLease.js';
import {
  resolveVerifiedNativeToolExecutable, resolveVerifiedNativeToolRoles,
} from './nativeToolsOracle.js';

const require = createRequire(import.meta.url);
const { runSupervisedSync } = require('../../scripts/windows-job-supervisor.js');

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

const REAL_MEDIA_RECEIPT = 'receipt.json';
const RECEIPT_KEYS = 'file|probe|schemaVersion|sha256|sizeBytes|url|videoId';
const PROBE_KEYS = 'audioCodec|durationSeconds|formatName|height|videoCodec|width';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_REAL_MEDIA_BYTES = 512 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024;

const sha256File = (path) => {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, 'r');
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest('hex');
};
const readJson = (path) => {
  const metadata = assertOrdinaryFile(path, 'real-media receipt');
  if (metadata.size < 2 || metadata.size > MAX_RECEIPT_BYTES) {
    throw new Error('the real-media receipt exceeds its bounded schema size');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
};
const samePath = (left, right) => (
  process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
);

const assertOrdinaryFile = (path, label) => {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} is not one ordinary singly-linked file`);
  }
  if (!samePath(realpathSync.native(path), path)) {
    throw new Error(`${label} crosses a redirected path`);
  }
  return metadata;
};

const assertManagedCacheRoot = (cacheRoot) => {
  const metadata = lstatSync(cacheRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('the real-media cache root is not one ordinary directory');
  }
  if (!samePath(realpathSync.native(cacheRoot), cacheRoot)) {
    throw new Error('the real-media cache root crosses a redirected path');
  }
  return cacheRoot;
};

export const verifyRealVideoProbe = (raw) => {
  const durationSeconds = Number(raw?.format?.duration);
  const formatName = String(raw?.format?.format_name ?? '');
  const streams = Array.isArray(raw?.streams) ? raw.streams : [];
  const video = streams.find(({ codec_type: type }) => type === 'video');
  const audio = streams.find(({ codec_type: type }) => type === 'audio');
  if (
    !Number.isFinite(durationSeconds)
    || Math.abs(durationSeconds - REAL_VIDEO.durationSeconds) > REAL_VIDEO.durationToleranceSeconds
    || !formatName.split(',').includes('mp4')
    || typeof video?.codec_name !== 'string'
    || video.codec_name.length === 0
    || !Number.isSafeInteger(video.width)
    || video.width < 1
    || !Number.isSafeInteger(video.height)
    || video.height < 1
    || typeof audio?.codec_name !== 'string'
    || audio.codec_name.length === 0
  ) {
    throw new Error(`the real-media candidate failed its semantic probe: ${JSON.stringify(raw)}`);
  }
  return Object.freeze({
    durationSeconds,
    formatName,
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
    width: video.width,
    height: video.height,
  });
};

const probeRealVideo = (path, {
  execute = execFileSync,
  ffprobe = null,
  nativeToolsCache = NATIVE_TOOLS_CACHE,
  resolveTool = resolveVerifiedNativeToolExecutable,
} = {}) => {
  const executable = ffprobe ?? resolveTool({
    storeRoot: nativeToolsCache, tool: 'media-tools', role: 'ffprobe',
  });
  const raw = JSON.parse(execute(executable, [
    '-v', 'error',
    '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height',
    '-of', 'json',
    path,
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true }));
  return verifyRealVideoProbe(raw);
};

const receiptFor = ({ file, fileName = basename(file), probe, videoId }) => {
  const metadata = assertOrdinaryFile(file, 'real-media payload');
  if (metadata.size <= 50_000 || metadata.size > MAX_REAL_MEDIA_BYTES) {
    throw new Error(`the real-media payload has an unsafe size: ${metadata.size}`);
  }
  return Object.freeze({
    schemaVersion: 1,
    videoId,
    url: REAL_VIDEO.url,
    file: fileName,
    sizeBytes: metadata.size,
    sha256: sha256File(file),
    probe,
  });
};

const validateReceiptShape = (receipt) => {
  if (
    receipt === null
    || typeof receipt !== 'object'
    || Object.keys(receipt).sort().join('|') !== RECEIPT_KEYS
    || receipt.schemaVersion !== 1
    || receipt.videoId !== REAL_VIDEO.id
    || receipt.url !== REAL_VIDEO.url
    || !new RegExp(`^${REAL_VIDEO.id}-[0-9a-f]{64}\\.mp4$`, 'u').test(receipt.file ?? '')
    || !Number.isSafeInteger(receipt.sizeBytes)
    || receipt.sizeBytes <= 50_000
    || !SHA256_PATTERN.test(receipt.sha256 ?? '')
    || receipt.probe === null
    || typeof receipt.probe !== 'object'
    || Object.keys(receipt.probe).sort().join('|') !== PROBE_KEYS
  ) return false;
  try {
    verifyRealVideoProbe({
      format: {
        duration: receipt.probe.durationSeconds,
        format_name: receipt.probe.formatName,
      },
      streams: [
        {
          codec_type: 'video', codec_name: receipt.probe.videoCodec,
          width: receipt.probe.width, height: receipt.probe.height,
        },
        { codec_type: 'audio', codec_name: receipt.probe.audioCodec },
      ],
    });
    return true;
  } catch {
    return false;
  }
};

export const cachedRealVideo = (cacheRoot = REAL_MEDIA_CACHE) => {
  const receiptPath = join(cacheRoot, REAL_MEDIA_RECEIPT);
  if (!existsSync(receiptPath)) return null;
  try {
    const receipt = readJson(receiptPath);
    if (!validateReceiptShape(receipt)) return null;
    const video = join(cacheRoot, receipt.file);
    if (!existsSync(video)) return null;
    const metadata = assertOrdinaryFile(video, 'cached real media');
    if (
      metadata.size !== receipt.sizeBytes
      || metadata.size > MAX_REAL_MEDIA_BYTES
      || sha256File(video) !== receipt.sha256
    ) return null;
    return video;
  } catch {
    return null;
  }
};

const atomicWriteJson = (path, value) => {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let descriptor = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
};

const publishRealVideo = ({
  assetRoot, assertStillLive, cacheRoot, candidate, probe, observedVideoId,
  afterPayload = () => {}, writeReceipt = atomicWriteJson,
}) => {
  if (!samePath(resolve(cacheRoot, '..'), assetRoot)) {
    throw new Error('the real-media cache is not one direct child of the leased asset root');
  }
  assertManagedCacheRoot(cacheRoot);
  const candidateInside = relative(cacheRoot, resolve(candidate));
  if (
    candidateInside === ''
    || candidateInside === '..'
    || candidateInside.startsWith(`..${sep}`)
    || candidateInside.includes(sep)
  ) {
    throw new Error('the real-media candidate must be one direct child of its managed cache');
  }
  assertOrdinaryFile(candidate, 'real-media candidate');
  const receiptPath = join(cacheRoot, REAL_MEDIA_RECEIPT);
  // Windows requires a writable handle for FlushFileBuffers (Node's fsync implementation).
  const descriptor = openSync(candidate, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const candidateIdentity = receiptFor({ file: candidate, probe, videoId: observedVideoId });
  const fileName = `${REAL_VIDEO.id}-${candidateIdentity.sha256}.mp4`;
  const destination = join(cacheRoot, fileName);
  const receipt = Object.freeze({ ...candidateIdentity, file: fileName });
  let previous = null;
  try {
    previous = existsSync(receiptPath) ? readJson(receiptPath) : null;
  } catch {
    // A malformed receipt owns nothing and must not prevent a leased repair.
  }
  const destinationAlreadyExists = existsSync(destination);
  if (destinationAlreadyExists) {
    const metadata = assertOrdinaryFile(destination, 'existing content-addressed real media');
    if (
      metadata.size !== receipt.sizeBytes
      || metadata.size > MAX_REAL_MEDIA_BYTES
      || sha256File(destination) !== receipt.sha256
    ) {
      throw new Error('the content-addressed real-media destination contains different bytes');
    }
    assertStillLive();
    rmSync(candidate, { force: true });
  } else {
    assertStillLive();
    renameSync(candidate, destination);
  }
  try {
    afterPayload(destination);
    assertStillLive();
    writeReceipt(receiptPath, receipt);
    if (cachedRealVideo(cacheRoot) !== destination) {
      throw new Error('the published real-media cache failed its receipt read-back');
    }
  } catch (error) {
    // Once authority is stale, this process may not perform even well-intentioned rollback writes.
    // An unreceipted content-addressed orphan is harmless and recoverable by the next live owner.
    assertStillLive();
    if (validateReceiptShape(previous)) atomicWriteJson(receiptPath, previous);
    else rmSync(receiptPath, { force: true });
    if (!destinationAlreadyExists) rmSync(destination, { force: true });
    throw error;
  }
  assertStillLive();
  if (
    validateReceiptShape(previous)
    && previous.file !== fileName
    && new RegExp(`^${REAL_VIDEO.id}-[0-9a-f]{64}\\.mp4$`, 'u').test(previous.file)
  ) {
    rmSync(join(cacheRoot, previous.file), { force: true });
  }
  return destination;
};

/** Independently validate a URL-workflow output before it becomes evidence. */
export const verifyRealVideoFile = (path, options = {}) => {
  const metadata = assertOrdinaryFile(path, 'real-media candidate');
  if (metadata.size <= 50_000 || metadata.size > MAX_REAL_MEDIA_BYTES) {
    throw new Error(`the real-media candidate has an unsafe size: ${metadata.size}`);
  }
  const probe = probeRealVideo(path, options);
  return Object.freeze({ ...receiptFor({ file: path, probe, videoId: REAL_VIDEO.id }), path });
};

const parseYtDlpObservation = (output, expectedPath) => {
  if (typeof output !== 'string' || output.length < 3 || output.length > 4096) {
    throw new Error('yt-dlp returned no bounded provider identity observation');
  }
  const lines = output.trim().split(/\r?\n/u);
  if (lines.length !== 1) throw new Error('yt-dlp returned an ambiguous provider identity observation');
  const [videoId, path, ...extra] = lines[0].split('\t');
  if (extra.length !== 0 || videoId !== REAL_VIDEO.id || !samePath(path ?? '', expectedPath)) {
    throw new Error('yt-dlp resolved a different provider identity or output path');
  }
  return videoId;
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
const ensureRealVideoCore = ({
  assetRoot,
  assertStillLive,
  cacheRoot,
  execute = execFileSync,
  nativeToolsCache = NATIVE_TOOLS_CACHE,
  resolveTool = resolveVerifiedNativeToolExecutable,
  resolveTools = resolveVerifiedNativeToolRoles,
  downloadRunner = (executable, args) => execute(executable, args, {
    encoding: 'utf8', timeout: 300_000, windowsHide: true,
  }),
  afterPayload = () => {},
  writeReceipt = atomicWriteJson,
} = {}) => {
  if (!samePath(resolve(cacheRoot, '..'), assetRoot)) {
    throw new Error('the real-media cache is not one direct child of the leased asset root');
  }
  mkdirSync(cacheRoot, { recursive: true });
  assertManagedCacheRoot(cacheRoot);
  const cached = cachedRealVideo(cacheRoot);
  if (cached !== null) return cached;

  const ytDlp = resolveTool({ storeRoot: nativeToolsCache, tool: 'yt-dlp', role: 'yt-dlp' });
  const deno = resolveTool({ storeRoot: nativeToolsCache, tool: 'deno', role: 'deno' });
  const { ffmpeg, ffprobe } = resolveTools({
    storeRoot: nativeToolsCache, tool: 'media-tools', roles: ['ffmpeg', 'ffprobe'],
  });
  const temporary = join(
    cacheRoot,
    `.${REAL_VIDEO.id}.${process.pid}.${randomBytes(6).toString('hex')}.tmp.mp4`,
  );
  try {
    const observation = downloadRunner(ytDlp, [
      '--js-runtimes', `deno:${deno}`,
      REAL_VIDEO.url,
      '--no-playlist',
      '--quiet',
      '--ffmpeg-location', dirname(ffmpeg),
      '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio',
      '--merge-output-format', 'mp4',
      '--output', temporary,
      '--print', 'after_move:%(id)s\t%(filepath)s',
    ]);
    if (!existsSync(temporary)) {
      throw new Error('yt-dlp reported success without writing the fixed real-media candidate');
    }
    const observedVideoId = parseYtDlpObservation(observation, temporary);
    const probe = probeRealVideo(temporary, { execute, ffprobe });
    return publishRealVideo({
      assetRoot, assertStillLive, cacheRoot, candidate: temporary, probe, observedVideoId,
      afterPayload, writeReceipt,
    });
  } finally {
    rmSync(temporary, { force: true });
  }
};

/** Managed-cache entry point: authority and mutation behavior are deliberately non-injectable. */
export const ensureRealVideo = ({ applicationLease } = {}) => {
  const assertStillLive = () => assertLiveE2eAssetLease(applicationLease);
  const assetRoot = assertStillLive();
  try {
    return ensureRealVideoCore({
      assetRoot,
      assertStillLive,
      cacheRoot: REAL_MEDIA_CACHE,
      downloadRunner: (executable, args) => {
      const result = runSupervisedSync({
        command: executable,
        args,
        cwd: REPOSITORY_ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
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
          `the supervised yt-dlp acquisition failed with exit ${result.status}: `
          + String(result.stderr ?? '').slice(0, 4096),
        );
      }
        return result.stdout;
      },
    });
  } catch (error) {
    if (/not installed|no such file|ENOENT/u.test(String(error?.message))) {
      throw new Error(
        'real-media bootstrap requires reviewed native tools; run '
        + '`npm --prefix e2e run test:download` once, then retry this journey',
        { cause: error },
      );
    }
    throw error;
  }
};

/**
 * Unit-test seam for crash/fault simulation. It is structurally unable to target the manager-owned
 * E2E asset tree and therefore cannot weaken the production authority boundary above.
 */
export const createRealMediaBootstrapForTest = ({
  cacheRoot, execute = execFileSync, resolveTool = resolveVerifiedNativeToolExecutable,
  afterPayload = () => {}, writeReceipt = atomicWriteJson, assertStillLive: testLiveness,
}) => {
  const candidate = resolve(cacheRoot);
  const managedRemainder = relative(E2E_ASSET_CACHE_ROOT, candidate);
  if (
    samePath(candidate, E2E_ASSET_CACHE_ROOT)
    || (managedRemainder !== '..'
      && !managedRemainder.startsWith(`..${sep}`)
      && !isAbsolute(managedRemainder))
  ) {
    throw new Error('the real-media test seam cannot target the manager-owned E2E asset tree');
  }
  const assetRoot = dirname(candidate);
  const assertStillLive = testLiveness ?? (() => assetRoot);
  return Object.freeze({
    ensure: () => ensureRealVideoCore({
      assetRoot, assertStillLive, cacheRoot: candidate, execute, resolveTool,
      resolveTools: ({ storeRoot, tool, roles }) => Object.fromEntries(roles.map(
        role => [role, resolveTool({ storeRoot, tool, role })],
      )),
      afterPayload, writeReceipt,
    }),
    publishCandidate: ({ file, probe, observedVideoId = REAL_VIDEO.id, fault = afterPayload }) => (
      publishRealVideo({
        assetRoot, assertStillLive, cacheRoot: candidate, candidate: file, probe,
        observedVideoId, afterPayload: fault, writeReceipt,
      })
    ),
  });
};
