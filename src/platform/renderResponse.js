// Native render response checks: staged export text, job snapshots, results and channel events.
import { isNativeMediaPlaybackUrl } from './mediaService';
import {
  RENDER_COMMAND_CODES,
  invalidRequest,
  invalidResponse,
  renderFailureMessage,
} from './renderErrors';
import { normalizeSourceAsset } from './renderRequest';
import {
  dataProperty,
  requireFinite,
  requireInteger,
  requireString,
  requireUuid,
  snapshotExactRecord,
  snapshotPlainRecord,
  uuidHasVersion,
} from './renderValidation';

/** Mirrors `EXPORT_TEXT_SCHEMA_VERSION` in `apps/desktop/src-tauri/src/render/text.rs`. */
const EXPORT_TEXT_SCHEMA_VERSION = 2;
const EXPORT_TEXT_KEYS = Object.freeze([
  'schemaVersion', 'face', 'pages', 'cues',
]);
const EXPORT_PAGE_KEYS = Object.freeze(['atlasId', 'atlasContentHash']);
const EXPORT_CUE_RUN_KEYS = Object.freeze(['page', 'lines']);
const EXPORT_CUE_LINE_KEYS = Object.freeze([
  'glyphs', 'penXPx', 'advanceWidthPx', 'baselineYPx',
]);
/** Mirrors `MAX_ATLAS_PAGES` in `crates/osg-scene/src/glyph/limits.rs`. */
const MAX_EXPORT_PAGES = 32;
const EXPORT_FACE_KEYS = Object.freeze(['family', 'source', 'weight']);
/** Mirrors `MAX_IDENTITY_BYTES` and `is_opaque_identity` in the same file. */
const OPAQUE_IDENTITY_PATTERN = /^[A-Za-z0-9\-_:]{1,128}$/;
/** Mirrors `MAX_RUN_LINES` and `MAX_RUN_GLYPHS` in `crates/osg-compositor/src/run.rs`. */
const MAX_EXPORT_RUN_LINES = 64;
const MAX_EXPORT_RUN_CELLS = 4_096;

const JOB_STATES = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const RENDER_PHASES = new Set([
  'staging', 'extractingFrames', 'extractingAudio', 'loadingComposition',
  'renderingFrames', 'encoding', 'muxing', 'publishing',
]);

/**
 * The staged text `render_start` draws with, checked for what belongs to THIS boundary.
 *
 * The architecture forbids a Rust text stack, so an export's glyphs arrive already shaped: the
 * staged atlas pages, and one laid-out run per cue — carrying its page — in the request's own cue
 * order.
 * `src/components/previews/native/exportTextStaging.js` produces it and
 * `apps/desktop/src-tauri/src/render/text.rs` deserialises it.
 *
 * Deliberately a SHAPE check and not a second opinion about layout. Whether the runs agree with the
 * atlas is decided by `osg_compositor::SubtitleScene`, which is the code that defines what a
 * drawable run is; restating any of it here would be a third vocabulary to keep in step. What is
 * checked is what this boundary owns: the payload version, the opacity of the identity it carries,
 * that it describes THESE cues, and the sizes it would otherwise make the far side allocate.
 *
 * The payload is copied field by field rather than forwarded, so nothing a caller mutates after
 * this returns can reach the command.
 */
const normalizeExportCueLine = (line) => {
  const snapshot = snapshotExactRecord(line, EXPORT_CUE_LINE_KEYS);
  if (snapshot === null
      || !Array.isArray(snapshot.glyphs)
      || !Array.isArray(snapshot.penXPx)
      || snapshot.glyphs.length !== snapshot.penXPx.length) {
    throw invalidRequest();
  }
  const glyphs = snapshot.glyphs.map((cell) => requireInteger(cell, 0, 0xffff_ffff));
  const penXPx = snapshot.penXPx.map((pen) => requireFinite(pen, -1e12, 1e12));
  return Object.freeze({
    glyphs: Object.freeze(glyphs),
    penXPx: Object.freeze(penXPx),
    advanceWidthPx: requireFinite(snapshot.advanceWidthPx, -1e12, 1e12),
    baselineYPx: requireFinite(snapshot.baselineYPx, -1e12, 1e12),
  });
};

const normalizeExportCueRun = (run, pageCount) => {
  const snapshot = snapshotExactRecord(run, EXPORT_CUE_RUN_KEYS);
  if (snapshot === null
      || !Array.isArray(snapshot.lines)
      || snapshot.lines.length === 0
      || snapshot.lines.length > MAX_EXPORT_RUN_LINES) {
    throw invalidRequest();
  }
  // A cue names the page its cells index. Whether the indices fit that page's table is
  // `osg_compositor::SubtitleScene`'s question; whether the page exists at all is this one's.
  const page = requireInteger(snapshot.page, 0, pageCount - 1);
  const lines = snapshot.lines.map(normalizeExportCueLine);
  const cells = lines.reduce((total, line) => total + line.glyphs.length, 0);
  if (cells > MAX_EXPORT_RUN_CELLS) throw invalidRequest();
  return Object.freeze({ page, lines: Object.freeze(lines) });
};

const normalizeExportPage = (page) => {
  const snapshot = snapshotExactRecord(page, EXPORT_PAGE_KEYS);
  if (snapshot === null
      || !uuidHasVersion(snapshot.atlasId, 7)
      || typeof snapshot.atlasContentHash !== 'string'
      || !OPAQUE_IDENTITY_PATTERN.test(snapshot.atlasContentHash)) {
    throw invalidRequest();
  }
  return Object.freeze({
    atlasId: snapshot.atlasId,
    atlasContentHash: snapshot.atlasContentHash,
  });
};

export const normalizeExportText = (text, request) => {
  const snapshot = snapshotExactRecord(text, EXPORT_TEXT_KEYS);
  const face = snapshot === null ? null : snapshotExactRecord(snapshot.face, EXPORT_FACE_KEYS);
  if (snapshot === null || face === null
      || snapshot.schemaVersion !== EXPORT_TEXT_SCHEMA_VERSION
      || !Array.isArray(snapshot.pages)
      || snapshot.pages.length === 0
      || snapshot.pages.length > MAX_EXPORT_PAGES
      || !Array.isArray(snapshot.cues)
      || !Array.isArray(request?.lyrics)
      || snapshot.cues.length !== request.lyrics.length) {
    throw invalidRequest();
  }
  // A face that never resolved is the failure this pipeline exists to stop hiding, so the payload
  // may not carry a weight or a byte source the renderer would have to guess at.
  requireString(face.family, 256);
  requireString(face.source, 256);
  requireInteger(face.weight, 100, 900);
  if (face.weight % 100 !== 0) throw invalidRequest();
  const pages = snapshot.pages.map(normalizeExportPage);
  return Object.freeze({
    schemaVersion: EXPORT_TEXT_SCHEMA_VERSION,
    face: Object.freeze({ family: face.family, source: face.source, weight: face.weight }),
    pages: Object.freeze(pages),
    cues: Object.freeze(snapshot.cues.map((run) => normalizeExportCueRun(run, pages.length))),
  });
};

export const normalizeRenderJob = (job) => {
  const snapshot = snapshotExactRecord(job, ['id', 'kind', 'state', 'progress', 'sequence']);
  const progressSnapshot = snapshot === null
    ? null
    : snapshotExactRecord(snapshot.progress, ['basisPoints']);
  if (snapshot === null || progressSnapshot === null
      || !uuidHasVersion(snapshot.id, 7)
      || snapshot.kind !== 'renderVideo'
      || !JOB_STATES.has(snapshot.state)) {
    throw invalidResponse();
  }
  const progress = requireInteger(progressSnapshot.basisPoints, 0, 10_000, true);
  const sequence = requireInteger(snapshot.sequence, 0, Number.MAX_SAFE_INTEGER, true);
  if ((snapshot.state === 'queued' && (progress !== 0 || sequence !== 0))
      || (snapshot.state === 'succeeded' && progress !== 10_000)
      || (!['queued', 'succeeded'].includes(snapshot.state) && sequence < 1)) {
    throw invalidResponse();
  }
  return Object.freeze({
    id: snapshot.id,
    kind: 'renderVideo',
    state: snapshot.state,
    progress: Object.freeze({ basisPoints: progress }),
    sequence,
  });
};

const normalizeMediaAsset = (asset) => {
  try {
    return normalizeSourceAsset(asset, { response: true });
  } catch {
    throw invalidResponse();
  }
};

const normalizePlayback = (playback, asset) => {
  const snapshot = snapshotExactRecord(
    playback,
    ['id', 'playbackUrl', 'mimeType', 'byteLength'],
  );
  if (snapshot === null
      || !uuidHasVersion(snapshot.id, 4)
      || !isNativeMediaPlaybackUrl(snapshot.playbackUrl, snapshot.id)
      || snapshot.mimeType !== 'video/mp4'
      || snapshot.byteLength !== asset.sizeBytes) {
    throw invalidResponse();
  }
  return snapshot;
};

const extractPlaybackCapability = (value) => {
  try {
    const resultPlayback = dataProperty(value, 'playback');
    const playback = snapshotExactRecord(
      resultPlayback?.value,
      ['id', 'playbackUrl', 'mimeType', 'byteLength'],
    );
    if (playback === null || !uuidHasVersion(playback.id, 4)
        || !isNativeMediaPlaybackUrl(playback.playbackUrl, playback.id)
        || playback.mimeType !== 'video/mp4'
        || !Number.isSafeInteger(playback.byteLength)
        || playback.byteLength <= 0) {
      return null;
    }
    return playback.id;
  } catch {
    return null;
  }
};

export const extractPlaybackOwnership = (value, expectedEvent = null) => {
  try {
    const eventName = dataProperty(value, 'event');
    if (expectedEvent !== null && eventName?.value !== expectedEvent) {
      return null;
    }
    const result = dataProperty(value, 'result');
    const playbackId = extractPlaybackCapability(result?.value);
    if (playbackId === null) return null;
    const jobValue = dataProperty(value, 'job');
    const job = snapshotPlainRecord(jobValue?.value);
    const jobId = job !== null && uuidHasVersion(job.id, 7) ? job.id : null;
    return Object.freeze({ jobId, playbackId });
  } catch {
    return null;
  }
};

export const extractCompletedPlaybackOwnership = (value) => (
  extractPlaybackOwnership(value, 'completed')
);

const normalizeRenderResult = (result) => {
  const snapshot = snapshotExactRecord(result, [
    'artifactId', 'asset', 'sourceAssetId', 'projectId', 'width', 'height', 'fps',
    'durationInFrames', 'playback',
  ]);
  if (snapshot === null) throw invalidResponse();
  const asset = normalizeMediaAsset(snapshot.asset);
  if (asset.kind !== 'video' || asset.extension !== 'mp4') throw invalidResponse();
  return Object.freeze({
    artifactId: requireUuid(snapshot.artifactId, 7, true),
    asset,
    sourceAssetId: requireUuid(snapshot.sourceAssetId, 7, true),
    projectId: requireUuid(snapshot.projectId, 7, true),
    width: requireInteger(snapshot.width, 2, 15_360, true),
    height: requireInteger(snapshot.height, 2, 8_640, true),
    fps: requireInteger(snapshot.fps, 1, 120, true),
    durationInFrames: requireInteger(snapshot.durationInFrames, 1, 1_000_000, true),
    playback: normalizePlayback(snapshot.playback, asset),
  });
};

export const normalizeRenderResultResponse = (value) => {
  const snapshot = snapshotExactRecord(value, ['job', 'result']);
  if (snapshot === null) throw invalidResponse();
  const job = normalizeRenderJob(snapshot.job);
  const result = snapshot.result === null ? null : normalizeRenderResult(snapshot.result);
  if (job.state === 'succeeded' ? result === null : result !== null) throw invalidResponse();
  return Object.freeze({ job, result });
};

const normalizeCommandError = (value) => {
  const snapshot = snapshotExactRecord(value, ['code', 'message']);
  if (snapshot === null || typeof snapshot.code !== 'string'
      || typeof snapshot.message !== 'string') {
    throw invalidResponse();
  }
  const code = RENDER_COMMAND_CODES.has(snapshot.code) ? snapshot.code : 'nativeRenderFailed';
  return Object.freeze({ code, message: renderFailureMessage(code) });
};

export const normalizeRenderEvent = (value) => {
  const eventSnapshot = snapshotPlainRecord(value);
  const eventName = eventSnapshot?.event;
  if (typeof eventName !== 'string') throw invalidResponse();
  if (eventName === 'progress') {
    const snapshot = snapshotExactRecord(eventSnapshot, [
      'event', 'job', 'phase', 'fractionMillionths', 'renderedFrames', 'encodedFrames',
      'durationInFrames',
    ]);
    if (snapshot === null || !RENDER_PHASES.has(snapshot.phase)) {
      throw invalidResponse();
    }
    const job = normalizeRenderJob(snapshot.job);
    if (job.state !== 'running') throw invalidResponse();
    const durationInFrames = requireInteger(snapshot.durationInFrames, 1, 1_000_000, true);
    return Object.freeze({
      event: 'progress',
      job,
      phase: snapshot.phase,
      fractionMillionths: requireInteger(snapshot.fractionMillionths, 0, 1_000_000, true),
      renderedFrames: requireInteger(snapshot.renderedFrames, 0, durationInFrames, true),
      encodedFrames: requireInteger(snapshot.encodedFrames, 0, durationInFrames, true),
      durationInFrames,
    });
  }
  if (eventName === 'completed') {
    const snapshot = snapshotExactRecord(eventSnapshot, ['event', 'job', 'result']);
    if (snapshot === null) throw invalidResponse();
    const job = normalizeRenderJob(snapshot.job);
    if (job.state !== 'succeeded') throw invalidResponse();
    return Object.freeze({
      event: 'completed',
      job,
      result: normalizeRenderResult(snapshot.result),
    });
  }
  if (eventName === 'cancelled') {
    const snapshot = snapshotExactRecord(eventSnapshot, ['event', 'job']);
    if (snapshot === null) throw invalidResponse();
    const job = normalizeRenderJob(snapshot.job);
    if (job.state !== 'cancelled') throw invalidResponse();
    return Object.freeze({ event: 'cancelled', job });
  }
  if (eventName === 'failed') {
    const snapshot = snapshotExactRecord(eventSnapshot, ['event', 'job', 'error']);
    if (snapshot === null) throw invalidResponse();
    const job = snapshot.job === null ? null : normalizeRenderJob(snapshot.job);
    if (job !== null && !['failed', 'succeeded'].includes(job.state)) throw invalidResponse();
    return Object.freeze({ event: 'failed', job, error: normalizeCommandError(snapshot.error) });
  }
  throw invalidResponse();
};
