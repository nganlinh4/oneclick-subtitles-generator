import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { withDatabase } from './database.js';
import { NATIVE_TOOLS_CACHE } from './environment.js';

const AUDIO_SAMPLE_RATE = 16_000;
const AUDIO_WINDOW_MS = 20;
const MAX_AUDIO_SECONDS = 30 * 60;
const MAX_AUDIO_BYTES = AUDIO_SAMPLE_RATE * 2 * MAX_AUDIO_SECONDS;
const ACTIVE_RMS_FLOOR = 0.002;
const SILENT_RMS_CEILING = 0.001;

const identifier = (value, label = 'identifier') => {
  const normalized = String(value ?? '').replaceAll('-', '').toLowerCase();
  assert.match(normalized, /^[0-9a-f]{32}$/u, `${label} is not one exact UUID`);
  return normalized;
};

const cueIdentity = (value, label = 'cue identity') => {
  assert.ok(
    (typeof value === 'string' && value.length > 0 && value.length <= 256)
      || (Number.isSafeInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER),
    `${label} is not one bounded legacy cue identity`,
  );
  return `${typeof value}:${String(value)}`;
};

const unique = (values, label) => {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
  return values;
};

const newlyCreated = (before, after, predicate) => {
  const existing = new Set(before.map(({ id }) => id));
  return after.filter((entry) => !existing.has(entry.id) && predicate(entry));
};

const installedTool = (fileName) => {
  const matches = [];
  const pending = [NATIVE_TOOLS_CACHE];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.name.toLowerCase() === fileName.toLowerCase()) matches.push(path);
    }
  }
  assert.equal(matches.length, 1, `expected one installed ${fileName}, found ${matches.length}`);
  return matches[0];
};

/** Read the native revision-owned narration checkpoint without asking the app to describe itself. */
export const durableProjectNarrations = (root) => withDatabase(root, (database) => (
  database.prepare(
    "SELECT key, value_json FROM app_settings WHERE scope = 'projectNarration' ORDER BY key",
  ).all().map(({ key, value_json: valueJson }) => ({ key, value: JSON.parse(valueJson) }))
));

/** Resolve an artifact only inside the disposable application's managed artifact directory. */
export const resolveManagedArtifact = (root, relativePath) => {
  assert.equal(typeof relativePath, 'string', 'artifact relative path is not text');
  assert.ok(relativePath.length > 0, 'artifact relative path is empty');
  const base = resolve(root, 'data', 'artifacts');
  const candidate = resolve(base, relativePath);
  const inside = relative(base, candidate);
  assert.ok(
    inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`),
    `artifact escaped the isolated managed root: ${relativePath}`,
  );
  assert.equal(existsSync(candidate), true, `managed artifact does not exist: ${relativePath}`);
  return candidate;
};

/**
 * Prove that one native batch produced exactly one unique project-owned artifact for every cue.
 *
 * This compares four independent views: the durable cue track, the durable job/artifact tables,
 * the revision-owned narration checkpoint, and the rendered result-row cardinality.
 */
export const verifyNarrationGenerationOwnership = ({
  before,
  after,
  records,
  surface,
  method = 'gtts',
}) => {
  assert.equal(after.projects.length, 1, 'narration journey must own exactly one project');
  assert.ok(after.cues.length > 0, 'narration journey has no durable cues');
  assert.deepEqual(
    { succeeded: surface.succeeded, pending: surface.pending, failed: surface.failed },
    { succeeded: after.cues.length, pending: 0, failed: 0 },
    'the visible narration rows do not exactly cover the durable cue track',
  );

  const jobs = newlyCreated(
    before.jobs,
    after.jobs,
    (job) => job.kind === 'synthesizeNarration',
  );
  assert.equal(jobs.length, 1, 'generation did not create exactly one native narration batch');
  const [job] = jobs;
  assert.equal(job.state, 'succeeded', 'the native narration batch is not successful');

  const artifacts = newlyCreated(
    before.artifacts,
    after.artifacts,
    (artifact) => artifact.kind === 'narrationOutput',
  );
  assert.equal(
    artifacts.length,
    after.cues.length,
    'generation did not publish exactly one narration artifact per durable cue',
  );
  unique(artifacts.map(({ id }) => id), 'narration artifact IDs');
  unique(artifacts.map(({ relative_path: path }) => path), 'narration artifact paths');

  const [project] = after.projects;
  const projectId = identifier(project.id, 'durable project ID');
  for (const artifact of artifacts) {
    assert.equal(identifier(artifact.project_id, 'artifact project ID'), projectId, (
      `artifact ${artifact.id} escaped the narration project`
    ));
    assert.equal(artifact.job_id, job.id, `artifact ${artifact.id} escaped its batch job`);
    assert.equal(artifact.state, 'ready', `artifact ${artifact.id} is not ready`);
    assert.ok(artifact.size_bytes > 128, `artifact ${artifact.id} is implausibly small`);
  }

  assert.equal(records.length, 1, 'the project has no single revision-owned narration checkpoint');
  const [{ key, value: record }] = records;
  assert.equal(record.schemaVersion, 1, 'narration checkpoint schema changed unexpectedly');
  assert.equal(identifier(record.projectId, 'checkpoint project ID'), projectId, (
    'narration checkpoint escaped the durable project'
  ));
  assert.equal(record.projectStateVersion, project.state_version, (
    'narration checkpoint is stale against the durable project revision'
  ));
  assert.equal(record.source, 'original', 'narration checkpoint changed subtitle source');
  assert.equal(key.toLowerCase().endsWith(':original'), true, 'narration checkpoint key lost its source');
  assert.equal(record.results.length, after.cues.length, (
    'narration checkpoint does not cover every durable cue exactly once'
  ));

  const artifactById = new Map(artifacts.map((artifact) => [identifier(artifact.id), artifact]));
  const cuesByOrdinal = new Map(after.cues.map((cue) => [Number(cue.ordinal), cue]));
  unique(record.results.map((result) => cueIdentity(result.subtitleId, 'result cue ID')), (
    'narration result cue IDs'
  ));
  unique(record.results.map((result) => identifier(result.artifactId, 'result artifact ID')), (
    'narration result artifact IDs'
  ));

  const bindings = record.results.map((result, index) => {
    const artifactId = identifier(result.artifactId, 'result artifact ID');
    const cue = cuesByOrdinal.get(Number(result.outputIndex));
    const artifact = artifactById.get(artifactId);
    assert.ok(cue, `narration result ${index + 1} belongs to no durable cue`);
    assert.ok(artifact, `narration result ${index + 1} belongs to no new artifact`);
    assert.equal(
      cueIdentity(result.subtitleId, 'result cue ID'),
      cueIdentity(Number(cue.ordinal), 'durable cue ordinal'),
      `narration result ${index + 1} lost its exact legacy cue identity`,
    );
    assert.equal(result.text, cue.text, `narration result ${index + 1} was generated for stale text`);
    assert.equal(result.method, method, `narration result ${index + 1} used the wrong provider`);
    assert.equal(result.outputIndex, Number(cue.ordinal), (
      `narration result ${index + 1} lost cue order`
    ));
    assert.deepEqual(
      result.originalIds.map((id) => cueIdentity(id, 'result lineage ID')),
      [cueIdentity(Number(cue.ordinal), 'durable cue lineage')],
      `narration result ${index + 1} lost its exact cue lineage`,
    );
    assert.equal(result.startMicros, Number(cue.start_ms) * 1_000, (
      `narration result ${index + 1} has the wrong start time`
    ));
    assert.equal(result.endMicros, Number(cue.end_ms) * 1_000, (
      `narration result ${index + 1} has the wrong end time`
    ));
    return Object.freeze({ cue, result, artifact });
  });
  assert.deepEqual(
    new Set(bindings.map(({ artifact }) => identifier(artifact.id))),
    new Set(artifacts.map(({ id }) => identifier(id))),
    'a new narration artifact is not bound to exactly one durable cue',
  );
  return Object.freeze({ projectId, job, artifacts: Object.freeze(artifacts), bindings: Object.freeze(bindings) });
};

/** Prove one newly-created job owns one newly-created project artifact of the requested kinds. */
export const verifySingleProjectArtifact = ({
  before,
  after,
  expectedProjectId,
  jobKind,
  artifactKind,
}) => {
  const jobs = newlyCreated(before.jobs, after.jobs, (job) => job.kind === jobKind);
  const artifacts = newlyCreated(
    before.artifacts,
    after.artifacts,
    (artifact) => artifact.kind === artifactKind,
  );
  assert.equal(jobs.length, 1, `${jobKind} did not create exactly one native job`);
  assert.equal(artifacts.length, 1, `${artifactKind} did not create exactly one durable artifact`);
  const [job] = jobs;
  const [artifact] = artifacts;
  assert.equal(job.state, 'succeeded', `${jobKind} did not succeed`);
  assert.equal(artifact.state, 'ready', `${artifactKind} is not ready`);
  assert.equal(artifact.job_id, job.id, `${artifactKind} lost its native job owner`);
  assert.equal(identifier(artifact.project_id), identifier(expectedProjectId), (
    `${artifactKind} escaped its exact project`
  ));
  return Object.freeze({ job, artifact });
};

/** Independently decode one audio stream into bounded mono 16-bit PCM. */
export const decodeAudioPcm16 = (path, {
  startSeconds = 0,
  durationSeconds = null,
  sampleRate = AUDIO_SAMPLE_RATE,
} = {}) => {
  assert.equal(existsSync(path), true, `audio input does not exist: ${path}`);
  assert.ok(Number.isSafeInteger(sampleRate) && sampleRate >= 8_000 && sampleRate <= 48_000, (
    'audio oracle sample rate is outside its reviewed range'
  ));
  assert.ok(Number.isFinite(startSeconds) && startSeconds >= 0, 'audio oracle start is invalid');
  if (durationSeconds !== null) {
    assert.ok(Number.isFinite(durationSeconds) && durationSeconds > 0, (
      'audio oracle duration is invalid'
    ));
    assert.ok(durationSeconds <= MAX_AUDIO_SECONDS, 'audio oracle duration exceeds its bound');
  }
  const arguments_ = ['-v', 'error', '-nostdin', '-i', path];
  if (startSeconds > 0) arguments_.push('-ss', String(startSeconds));
  if (durationSeconds !== null) arguments_.push('-t', String(durationSeconds));
  arguments_.push(
    '-map', '0:a:0', '-ac', '1', '-ar', String(sampleRate),
    '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1',
  );
  const bytes = execFileSync(installedTool('ffmpeg.exe'), arguments_, {
    encoding: 'buffer',
    maxBuffer: durationSeconds === null
      ? MAX_AUDIO_BYTES
      : Math.min(MAX_AUDIO_BYTES, Math.ceil(durationSeconds * sampleRate * 2) + (1024 * 1024)),
    timeout: 120_000,
    windowsHide: true,
  });
  assert.ok(bytes.length >= sampleRate / 4, `audio decode is implausibly short: ${path}`);
  assert.equal(bytes.length % 2, 0, 'audio decoder returned a partial PCM sample');
  return Object.freeze({ bytes, sampleRate });
};

/** Convert decoded PCM into a time-indexed RMS envelope with no codec metadata trust. */
export const analyzePcm16 = (pcm, {
  sampleRate = AUDIO_SAMPLE_RATE,
  windowMs = AUDIO_WINDOW_MS,
} = {}) => {
  assert.ok(pcm instanceof Uint8Array, 'PCM input must be a byte array');
  assert.equal(pcm.byteLength % 2, 0, 'PCM input ends with a partial sample');
  assert.ok(Number.isSafeInteger(sampleRate) && sampleRate >= 8_000 && sampleRate <= 48_000, (
    'PCM sample rate is outside its reviewed range'
  ));
  assert.ok(Number.isSafeInteger(windowMs) && windowMs >= 5 && windowMs <= 100, (
    'PCM analysis window is outside its reviewed range'
  ));
  const samplesPerWindow = Math.round(sampleRate * windowMs / 1_000);
  assert.ok(samplesPerWindow > 0, 'PCM analysis window has no samples');
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const sampleCount = pcm.byteLength / 2;
  const windows = [];
  let maximumRms = 0;
  let maximumPeak = 0;
  for (let start = 0; start < sampleCount; start += samplesPerWindow) {
    const end = Math.min(sampleCount, start + samplesPerWindow);
    let squares = 0;
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      const sample = view.getInt16(index * 2, true) / 32_768;
      squares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(squares / (end - start));
    maximumRms = Math.max(maximumRms, rms);
    maximumPeak = Math.max(maximumPeak, peak);
    windows.push(Object.freeze({
      startSeconds: start / sampleRate,
      endSeconds: end / sampleRate,
      rms,
      peak,
    }));
  }
  return Object.freeze({
    sampleRate,
    windowMs,
    durationSeconds: sampleCount / sampleRate,
    maximumRms,
    maximumPeak,
    windows: Object.freeze(windows),
  });
};

export const audioWindow = (analysis, startSeconds, endSeconds) => {
  assert.ok(Number.isFinite(startSeconds) && Number.isFinite(endSeconds)
    && startSeconds >= 0 && endSeconds > startSeconds, 'audio window is invalid');
  const windows = analysis.windows.filter((window) => (
    window.endSeconds > startSeconds && window.startSeconds < endSeconds
  ));
  assert.ok(windows.length > 0, `audio window ${startSeconds}-${endSeconds}s has no samples`);
  return Object.freeze({
    startSeconds,
    endSeconds,
    maximumRms: Math.max(...windows.map(({ rms }) => rms)),
    maximumPeak: Math.max(...windows.map(({ peak }) => peak)),
    meanRms: windows.reduce((sum, { rms }) => sum + rms, 0) / windows.length,
    windows: Object.freeze(windows),
  });
};

/** Reproduce only the documented alignment-placement contract from measured clip durations. */
export const expectedNarrationPlacements = (bindings, clipDurationsSeconds) => {
  assert.equal(bindings.length, clipDurationsSeconds.length, (
    'every narration binding needs one independently measured clip duration'
  ));
  let previousEnd = 0;
  return Object.freeze(bindings.map(({ cue }, index) => {
    const requestedStart = Number(cue.start_ms) / 1_000;
    const cueEnd = Number(cue.end_ms) / 1_000;
    const duration = Number(clipDurationsSeconds[index]);
    assert.ok(Number.isFinite(duration) && duration > 0, `clip ${index + 1} duration is invalid`);
    const needsRecovery = index > 0 && requestedStart < previousEnd - 0.3;
    const start = needsRecovery ? Math.max(0, previousEnd - 0.2) : requestedStart;
    const end = start + duration;
    previousEnd = Math.max(previousEnd, end);
    return Object.freeze({
      cueId: identifier(cue.id),
      requestedStart,
      cueEnd,
      start,
      end,
      shifted: needsRecovery,
    });
  }));
};

/** Require independently decoded speech to begin inside every native placement window. */
export const verifyCueAlignedSignal = ({
  analysis,
  placements,
  label,
  maximumOnsetDelaySeconds = 0.8,
}) => {
  assert.ok(analysis.maximumRms >= ACTIVE_RMS_FLOOR, `${label} is silent`);
  const activeThreshold = Math.max(ACTIVE_RMS_FLOOR, analysis.maximumRms * 0.02);
  const onset = placements.map((placement, index) => {
    const end = Math.min(
      analysis.durationSeconds,
      Math.max(placement.start + maximumOnsetDelaySeconds, placement.end),
    );
    const region = audioWindow(analysis, placement.start, end);
    const first = region.windows.find(({ rms }) => rms >= activeThreshold) ?? null;
    assert.ok(first, `${label} has no decoded speech for cue ${index + 1}`);
    assert.ok(first.startSeconds <= placement.start + maximumOnsetDelaySeconds, (
      `${label} cue ${index + 1} starts ${first.startSeconds - placement.start}s late`
    ));
    return Object.freeze({
      cueId: placement.cueId,
      expectedStartSeconds: placement.start,
      observedStartSeconds: first.startSeconds,
      onsetDelaySeconds: first.startSeconds - placement.start,
      maximumRms: region.maximumRms,
    });
  });
  if (placements[0].start >= 0.2) {
    const preroll = audioWindow(analysis, 0, placements[0].start - 0.1);
    assert.ok(preroll.maximumRms <= SILENT_RMS_CEILING, (
      `${label} leaked audio before the first cue: ${preroll.maximumRms}`
    ));
  }
  return Object.freeze({ activeThreshold, onset: Object.freeze(onset) });
};

const pearson = (left, right) => {
  assert.equal(left.length, right.length, 'correlation inputs differ in length');
  assert.ok(left.length >= 8, 'correlation input is too short');
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquares += leftDelta * leftDelta;
    rightSquares += rightDelta * rightDelta;
  }
  const denominator = Math.sqrt(leftSquares * rightSquares);
  return denominator === 0 ? 0 : numerator / denominator;
};

/** Find envelope correlation while tolerating only a bounded codec priming offset. */
export const bestEnvelopeCorrelation = (left, right, maximumOffsetWindows = 6) => {
  assert.ok(Number.isSafeInteger(maximumOffsetWindows) && maximumOffsetWindows >= 0
    && maximumOffsetWindows <= 25, 'correlation offset is outside its reviewed bound');
  const leftValues = left.windows.map(({ rms }) => rms);
  const rightValues = right.windows.map(({ rms }) => rms);
  let best = { correlation: -1, offsetWindows: 0, samples: 0 };
  for (let offset = -maximumOffsetWindows; offset <= maximumOffsetWindows; offset += 1) {
    const leftStart = Math.max(0, -offset);
    const rightStart = Math.max(0, offset);
    const length = Math.min(leftValues.length - leftStart, rightValues.length - rightStart);
    if (length < 8) continue;
    const correlation = pearson(
      leftValues.slice(leftStart, leftStart + length),
      rightValues.slice(rightStart, rightStart + length),
    );
    if (correlation > best.correlation) best = { correlation, offsetWindows: offset, samples: length };
  }
  return Object.freeze(best);
};

/**
 * Prove the final video carries the aligned narration and not the muted source track.
 *
 * The aligned/exported envelopes must correlate after at most 120 ms of codec priming, every cue
 * must remain audible, and a source-audible tail after narration ends must become silent in export.
 */
export const verifyNarrationOnlyExportMix = ({
  aligned,
  exported,
  source,
  placements,
  sourceDurationSeconds,
}) => {
  const exportedAlignment = verifyCueAlignedSignal({
    analysis: exported,
    placements,
    label: 'final exported-video narration mix',
  });
  const alignedExtent = Math.min(aligned.durationSeconds, exported.durationSeconds);
  const alignedWindows = Object.freeze({
    ...aligned,
    windows: Object.freeze(aligned.windows.filter(({ startSeconds }) => startSeconds < alignedExtent)),
  });
  const exportedWindows = Object.freeze({
    ...exported,
    windows: Object.freeze(exported.windows.filter(({ startSeconds }) => startSeconds < alignedExtent)),
  });
  const correlation = bestEnvelopeCorrelation(alignedWindows, exportedWindows);
  assert.ok(correlation.correlation >= 0.8, (
    `final video audio does not match aligned narration: ${JSON.stringify(correlation)}`
  ));

  const narrationEnd = Math.max(...placements.map(({ end }) => end));
  const tailStart = Math.min(sourceDurationSeconds - 0.5, narrationEnd + 0.5);
  const tailEnd = sourceDurationSeconds - 0.1;
  assert.ok(tailEnd - tailStart >= 0.5, 'source has no independent post-narration tail window');
  const sourceTail = audioWindow(source, tailStart, tailEnd);
  // A muxer may either pad the selected audio stream with zero samples through the video end or
  // finish the audio stream after narration. Both are silence. Requiring a padded stream would test
  // one container spelling rather than the customer-visible absence of the muted source track.
  const exportedTail = exported.durationSeconds <= tailStart
    ? Object.freeze({
      startSeconds: tailStart,
      endSeconds: tailEnd,
      maximumRms: 0,
      maximumPeak: 0,
      meanRms: 0,
      windows: Object.freeze([]),
      absentAfterNarration: true,
    })
    : audioWindow(exported, tailStart, Math.min(tailEnd, exported.durationSeconds));
  assert.ok(sourceTail.maximumRms >= ACTIVE_RMS_FLOOR, (
    `source tail cannot prove the original-audio counterfactual: ${sourceTail.maximumRms}`
  ));
  assert.ok(exportedTail.maximumRms <= SILENT_RMS_CEILING, (
    `muted original audio leaked into the final video tail: ${exportedTail.maximumRms}`
  ));
  return Object.freeze({ correlation, sourceTail, exportedTail, exportedAlignment });
};

export const NARRATION_AUDIO_ORACLE = Object.freeze({
  sampleRate: AUDIO_SAMPLE_RATE,
  windowMs: AUDIO_WINDOW_MS,
  activeRmsFloor: ACTIVE_RMS_FLOOR,
  silentRmsCeiling: SILENT_RMS_CEILING,
});
