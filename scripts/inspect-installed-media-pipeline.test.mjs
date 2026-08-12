import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PIPELINE_EXPRESSION,
  assertMediaPipelineResult,
  parseArguments,
  summarizeMediaPipelineResult,
} from './inspect-installed-media-pipeline.mjs';

const SOURCE_ID = '019ff572-2132-7ba1-8e9c-5a29894963bf';
const CLIP_ID = '019ff572-2133-7ba1-8e9c-5a29894963bf';
const AUDIO_ID = '019ff572-2134-7ba1-8e9c-5a29894963bf';
const SOURCE_NAME = 'osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4';
const JOB_IDS = Object.freeze({
  preparePlayback: '019ff572-2140-7ba1-8e9c-5a29894963bf',
  analysisClip: '019ff572-2141-7ba1-8e9c-5a29894963bf',
  extractAudio: '019ff572-2142-7ba1-8e9c-5a29894963bf',
  generateWaveform: '019ff572-2143-7ba1-8e9c-5a29894963bf',
});
const PLAYBACK_IDS = Object.freeze({
  source: '11111111-2222-4333-8444-555555555551',
  prepared: '11111111-2222-4333-8444-555555555552',
  clip: '11111111-2222-4333-8444-555555555553',
  audio: '11111111-2222-4333-8444-555555555554',
});

const asset = (id, displayName, extension, sizeBytes, kind) => ({
  id, displayName, extension, sizeBytes, kind,
});

const playback = (id, mimeType, byteLength) => ({
  id,
  playbackUrl: `http://127.0.0.1:43123/asset/${id}?token=${'a'.repeat(64)}`,
  mimeType,
  byteLength,
});

const inspection = (assetId, {
  durationUs,
  hasVideo,
  hasAudio,
  videoCodec,
  audioCodec,
  width,
  height,
}) => ({
  assetId,
  durationUs,
  hasVideo,
  hasAudio,
  videoCodec,
  audioCodec,
  width,
  height,
  frameRate: hasVideo ? 24 : null,
  compatibilityAction: 'direct',
  issues: [],
});

const nativeJob = (operation, kind, state, basisPoints, sequence) => ({
  id: JOB_IDS[operation],
  kind,
  state,
  progress: { basisPoints },
  sequence,
});

const operation = (name, kind, result, playbackProbe = null) => ({
  initial: nativeJob(name, kind, 'running', 0, 1),
  events: [
    {
      event: 'progress',
      operation: name,
      phase: 'probing',
      fraction: null,
      job: nativeJob(name, kind, 'running', 0, 1),
    },
    {
      event: 'progress',
      operation: name,
      phase: 'publishing',
      fraction: null,
      job: nativeJob(name, kind, 'running', 9_700, 2),
    },
    {
      event: 'completed',
      operation: name,
      job: nativeJob(name, kind, 'succeeded', 10_000, 3),
      result,
    },
  ],
  playbackProbe,
});

const mediaResult = (mediaAsset, mediaPlayback, mediaInspection) => ({
  kind: 'media',
  media: { asset: mediaAsset, playback: mediaPlayback },
  inspection: mediaInspection,
});

const probe = (kind, duration, width, height) => ({
  canPlay: true,
  duration,
  height,
  kind,
  metadataLoaded: true,
  readyState: 4,
  width,
});

const validResult = () => {
  const sourceAsset = asset(SOURCE_ID, SOURCE_NAME, 'mp4', 366_888, 'video');
  const sourcePlayback = playback(PLAYBACK_IDS.source, 'video/mp4', sourceAsset.sizeBytes);
  const sourceInspection = inspection(SOURCE_ID, {
    durationUs: 4_000_000,
    hasVideo: true,
    hasAudio: true,
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 640,
    height: 360,
  });
  const preparedPlayback = playback(
    PLAYBACK_IDS.prepared,
    'video/mp4',
    sourceAsset.sizeBytes,
  );
  const clipAsset = asset(CLIP_ID, 'analysis-clip.mp4', 'mp4', 180_000, 'video');
  const clipPlayback = playback(PLAYBACK_IDS.clip, 'video/mp4', clipAsset.sizeBytes);
  const audioAsset = asset(AUDIO_ID, 'extracted-audio.wav', 'wav', 384_078, 'audio');
  const audioPlayback = playback(PLAYBACK_IDS.audio, 'audio/wav', audioAsset.sizeBytes);
  const waveform = {
    kind: 'waveform',
    assetId: SOURCE_ID,
    waveform: {
      durationUs: 4_000_000,
      sourceSampleRateHz: 400,
      levels: [{
        pointsPerSecond: 100,
        points: Array.from({ length: 400 }, () => ({
          minimum: -0.5,
          maximum: 0.5,
          rootMeanSquare: 0.25,
        })),
      }],
    },
  };
  return {
    analysisClip: operation(
      'analysisClip',
      'processMedia',
      mediaResult(clipAsset, clipPlayback, inspection(CLIP_ID, {
        durationUs: 1_500_000,
        hasVideo: true,
        hasAudio: true,
        videoCodec: 'h264',
        audioCodec: 'aac',
        width: 640,
        height: 360,
      })),
      probe('video', 1.5, 640, 360),
    ),
    errorToastMessages: [],
    extractAudio: operation(
      'extractAudio',
      'processMedia',
      mediaResult(audioAsset, audioPlayback, inspection(AUDIO_ID, {
        durationUs: 2_000_000,
        hasVideo: false,
        hasAudio: true,
        videoCodec: null,
        audioCodec: 'pcm_s16le',
        width: null,
        height: null,
      })),
      probe('audio', 2, null, null),
    ),
    generateWaveform: operation('generateWaveform', 'generateWaveform', waveform),
    preparePlayback: operation(
      'preparePlayback',
      'processMedia',
      mediaResult(sourceAsset, preparedPlayback, sourceInspection),
      probe('video', 4, 640, 360),
    ),
    source: { asset: sourceAsset, playback: sourcePlayback },
    sourceInspection,
  };
};

test('parses only a bounded DevTools port and display name', () => {
  assert.deepEqual(parseArguments([
    '--port', '43123', '--expected-source-name', SOURCE_NAME,
  ]), { port: 43123, expectedSourceName: SOURCE_NAME });
  assert.throws(() => parseArguments([
    '--port', '80', '--expected-source-name', SOURCE_NAME,
  ]), /unprivileged TCP port/);
  assert.throws(() => parseArguments([
    '--port', '43123', '--expected-source-name', '../fixture.mp4',
  ]), /source name is invalid/);
  assert.throws(() => parseArguments([
    '--port', '43123', '--expected-source-name', SOURCE_NAME, '--path', 'C:\\fixture.mp4',
  ]), /Only reviewed/);
});

test('drives only reviewed opaque commands and CSP-compatible media element probes', () => {
  for (const command of [
    'get_session_snapshot',
    'media_pipeline_inspect',
    'media_pipeline_start',
    'media_pipeline_cancel',
  ]) {
    assert.match(PIPELINE_EXPRESSION, new RegExp(`['"]${command}['"]`));
  }
  for (const operationName of [
    'preparePlayback',
    'analysisClip',
    'extractAudio',
    'generateWaveform',
  ]) {
    assert.match(PIPELINE_EXPRESSION, new RegExp(`operation: ['"]${operationName}['"]`));
  }
  assert.match(PIPELINE_EXPRESSION, /__CHANNEL__:/);
  assert.match(PIPELINE_EXPRESSION, /document\.createElement\(kind\)/);
  assert.match(PIPELINE_EXPRESSION, /['"]loadedmetadata['"]/);
  assert.match(PIPELINE_EXPRESSION, /['"]canplay['"]/);
  assert.match(PIPELINE_EXPRESSION, /media\.removeAttribute\(['"]src['"]\)/);
  assert.match(PIPELINE_EXPRESSION, /media\.remove\(\)/);
  assert.match(PIPELINE_EXPRESSION,
    /initial !== null && terminalEvent !== null && channelEnded/);
  assert.match(PIPELINE_EXPRESSION, /channelEnded = true/);
  assert.match(PIPELINE_EXPRESSION, /startUs: 750000[\s\S]*endUs: 2250000/);
  assert.match(PIPELINE_EXPRESSION,
    /pointsPerSecond: 100[\s\S]*maxPoints: 1000[\s\S]*startUs: 0[\s\S]*endUs: null/);
  assert.doesNotMatch(PIPELINE_EXPRESSION,
    /\bfetch\s*\(|XMLHttpRequest|select_media|open_media_asset|outputPath|nativePath/);
});

test('accepts the complete path-free installed native media pipeline', () => {
  const result = validResult();
  assert.equal(assertMediaPipelineResult(result, SOURCE_NAME), result);
  const summary = summarizeMediaPipelineResult(result);
  assert.deepEqual(summary, {
    sourceAssetId: SOURCE_ID,
    sourceDurationUs: 4_000_000,
    compatibilityAction: 'direct',
    preparedAssetId: SOURCE_ID,
    compatibilityZeroCopy: true,
    clipAssetId: CLIP_ID,
    clipDurationUs: 1_500_000,
    clipBytes: 180_000,
    audioAssetId: AUDIO_ID,
    audioDurationUs: 2_000_000,
    audioBytes: 384_078,
    waveformDurationUs: 4_000_000,
    waveformLevels: 1,
    waveformPoints: 400,
    capabilityChecks: 3,
  });
  assert.doesNotMatch(JSON.stringify(summary),
    /(?:token|playback|localhost|127\.0\.0\.1|file:\/\/|[A-Za-z]:[\\/]|\\\\)/i);
});

test('rejects filesystem leakage before accepting otherwise plausible output', () => {
  const leaked = validResult();
  leaked.analysisClip.events.at(-1).result.outputPath = 'C:\\private\\analysis-clip.mp4';
  assert.throws(() => assertMediaPipelineResult(leaked, SOURCE_NAME), /filesystem path/);

  const embeddedLeak = validResult();
  embeddedLeak.errorToastMessages.push('Native failure at C:\\private\\analysis-clip.mp4');
  assert.throws(() => assertMediaPipelineResult(embeddedLeak, SOURCE_NAME), /filesystem path/);
});

test('rejects stale identities and forged tokenized playback responses', () => {
  const staleClip = validResult();
  const clip = staleClip.analysisClip.events.at(-1).result;
  clip.media.asset.id = SOURCE_ID;
  clip.inspection.assetId = SOURCE_ID;
  assert.throws(() => assertMediaPipelineResult(staleClip, SOURCE_NAME), /analysis-clip/);

  const forgedPlayback = validResult();
  forgedPlayback.extractAudio.playbackProbe.duration = 3;
  assert.throws(() => assertMediaPipelineResult(forgedPlayback, SOURCE_NAME),
    /decode the tokenized playback/);
});

test('rejects timing drift, regressed jobs, and silent or oversized waveform claims', () => {
  const clipDrift = validResult();
  clipDrift.analysisClip.events.at(-1).result.inspection.durationUs = 1_800_000;
  assert.throws(() => assertMediaPipelineResult(clipDrift, SOURCE_NAME), /inspection/);

  const regression = validResult();
  regression.extractAudio.events.at(-1).job.sequence = 1;
  assert.throws(() => assertMediaPipelineResult(regression, SOURCE_NAME), /progress regressed/);

  const incomplete = validResult();
  incomplete.extractAudio.events.at(-1).job.progress.basisPoints = 9_999;
  assert.throws(() => assertMediaPipelineResult(incomplete, SOURCE_NAME), /terminal progress/);

  const silent = validResult();
  silent.generateWaveform.events.at(-1).result.waveform.levels[0].points
    .forEach((point) => { point.rootMeanSquare = 0; });
  assert.throws(() => assertMediaPipelineResult(silent, SOURCE_NAME), /audio signal/);
});

test('rejects phase reordering, forged publishing progress, and post-terminal data', () => {
  const reordered = validResult();
  [reordered.analysisClip.events[0], reordered.analysisClip.events[1]] = [
    reordered.analysisClip.events[1], reordered.analysisClip.events[0],
  ];
  assert.throws(() => assertMediaPipelineResult(reordered, SOURCE_NAME), /phases out of order/);

  const forgedPublishing = validResult();
  forgedPublishing.extractAudio.events[1].job.progress.basisPoints = 9_000;
  assert.throws(() => assertMediaPipelineResult(forgedPublishing, SOURCE_NAME),
    /publishing phase/);

  const postTerminal = validResult();
  postTerminal.preparePlayback.events.push({
    event: 'progress',
    operation: 'preparePlayback',
    phase: 'publishing',
    fraction: null,
    job: nativeJob('preparePlayback', 'processMedia', 'running', 9_700, 4),
  });
  assert.throws(() => assertMediaPipelineResult(postTerminal, SOURCE_NAME),
    /data after completion/);
});
