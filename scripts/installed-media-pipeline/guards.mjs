// Acceptance guards for the installed media pipeline: path-free results, exact jobs, playback
// capabilities, operation envelopes, clip/audio/waveform outputs, and a bounded summary.

import {
  AUDIO_DURATION,
  CLIP_DURATION,
  MAX_OPERATION_EVENTS,
  PHASES,
  PLAYBACK_URL,
  PROCESSING_END_BASIS_POINTS,
  PUBLISHING_BASIS_POINTS,
  SOURCE_DURATION,
  UUID_V4,
  UUID_V7,
  hasExactKeys,
  invariant,
  isBoundedInteger,
} from './shared.mjs';

const findFilesystemLeaks = (value, location = '$', leaks = []) => {
  if (typeof value === 'string') {
    if (/(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\|file:(?:\/\/)?)/i.test(value)
        || /(?:^|[\s"'(=])\/(?:Users|home|tmp|var|private|mnt|opt|Volumes)(?:\/|$)/.test(value)) {
      leaks.push(location);
    }
    return leaks;
  }
  if (value === null || typeof value !== 'object') return leaks;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findFilesystemLeaks(item, `${location}[${index}]`, leaks));
    return leaks;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/(?:^|_)(?:file_?)?paths?$/i.test(key)
        || /(?:file|native|output|source)Path$/i.test(key)) {
      leaks.push(`${location}.${key}`);
    }
    findFilesystemLeaks(item, `${location}.${key}`, leaks);
  }
  return leaks;
};

const assertJob = (job, expectedKind, expectedState, message) => {
  invariant(hasExactKeys(job, ['id', 'kind', 'state', 'progress', 'sequence'])
    && UUID_V7.test(job.id ?? '')
    && job.kind === expectedKind
    && job.state === expectedState
    && hasExactKeys(job.progress, ['basisPoints'])
    && isBoundedInteger(job.progress.basisPoints, 0, 10_000)
    && isBoundedInteger(job.sequence), message);
};

const assertAsset = (asset, {
  displayName,
  extension,
  kind,
  excludedIds = [],
}) => {
  invariant(hasExactKeys(asset, ['id', 'displayName', 'extension', 'sizeBytes', 'kind'])
    && UUID_V7.test(asset.id ?? '')
    && !excludedIds.includes(asset.id)
    && asset.displayName === displayName
    && asset.extension === extension
    && asset.kind === kind
    && isBoundedInteger(asset.sizeBytes, 1),
  `Installed media pipeline returned an invalid ${displayName} asset`);
};

const assertPlayback = (playback, asset, mimeType) => {
  const match = typeof playback?.playbackUrl === 'string'
    ? PLAYBACK_URL.exec(playback.playbackUrl)
    : null;
  invariant(hasExactKeys(playback, ['id', 'playbackUrl', 'mimeType', 'byteLength'])
    && UUID_V4.test(playback.id ?? '')
    && match !== null
    && Number(match[1]) >= 1 && Number(match[1]) <= 65_535
    && match[2].toLowerCase() === playback.id.toLowerCase()
    && playback.mimeType === mimeType
    && playback.byteLength === asset.sizeBytes,
  `Installed media pipeline returned an invalid ${mimeType} playback capability`);
};

const assertPlaybackProbe = (probe, playback, {
  kind,
  duration,
  width,
  height,
}) => {
  invariant(hasExactKeys(probe, [
    'canPlay', 'duration', 'height', 'kind', 'metadataLoaded', 'readyState', 'width',
  ])
    && probe.kind === kind
    && playback.mimeType.startsWith(`${kind}/`)
    && probe.metadataLoaded === true
    && probe.canPlay === true
    && Number.isInteger(probe.readyState) && probe.readyState >= 3
    && typeof probe.duration === 'number' && Number.isFinite(probe.duration)
    && probe.duration * 1_000_000 >= duration.minimum
    && probe.duration * 1_000_000 <= duration.maximum
    && probe.width === width
    && probe.height === height,
  'Installed media pipeline could not decode the tokenized playback capability');
};

const assertInspection = (inspection, assetId, {
  duration,
  hasVideo,
  hasAudio,
  videoCodec,
  audioCodec,
  width,
  height,
}) => {
  invariant(hasExactKeys(inspection, [
    'assetId', 'durationUs', 'hasVideo', 'hasAudio', 'videoCodec', 'audioCodec',
    'width', 'height', 'frameRate', 'compatibilityAction', 'issues',
  ])
    && inspection.assetId === assetId
    && isBoundedInteger(inspection.durationUs, duration.minimum, duration.maximum)
    && inspection.hasVideo === hasVideo
    && inspection.hasAudio === hasAudio
    && inspection.videoCodec === videoCodec
    && inspection.audioCodec === audioCodec
    && inspection.width === width
    && inspection.height === height
    && (hasVideo
      ? typeof inspection.frameRate === 'number'
        && inspection.frameRate >= 23.9 && inspection.frameRate <= 24.1
      : inspection.frameRate === null)
    && inspection.compatibilityAction === 'direct'
    && Array.isArray(inspection.issues) && inspection.issues.length === 0,
  'Installed media pipeline inspection did not match the reviewed fixture contract');
};

const assertOperationEnvelope = (operation, name, expectedKind) => {
  invariant(hasExactKeys(operation, ['events', 'initial', 'playbackProbe']),
    `Installed ${name} operation returned an invalid envelope`);
  assertJob(operation.initial, expectedKind, 'running',
    `Installed ${name} operation did not start a native running job`);
  invariant(Array.isArray(operation.events)
    && operation.events.length >= 3
    && operation.events.length <= MAX_OPERATION_EVENTS,
    `Installed ${name} operation omitted its bounded event history`);
  invariant(operation.initial.progress.basisPoints === 0,
    `Installed ${name} operation did not start at zero progress`);
  let previousSequence = operation.initial.sequence;
  let previousProgress = operation.initial.progress.basisPoints;
  let previousPhaseRank = -1;
  let probingEvents = 0;
  let publishingEvents = 0;
  const phaseRanks = Object.freeze({ probing: 0, processing: 1, publishing: 2 });
  operation.events.forEach((event, index) => {
    invariant(event?.operation === name,
      `Installed ${name} operation reported a mismatched operation`);
    if (event.event === 'progress') {
      invariant(hasExactKeys(event, ['event', 'job', 'operation', 'phase', 'fraction'])
        && PHASES.has(event.phase)
        && (event.fraction === null
          || (typeof event.fraction === 'number'
            && Number.isFinite(event.fraction)
            && event.fraction >= 0 && event.fraction <= 1)),
      `Installed ${name} operation returned an invalid progress event`);
      assertJob(event.job, expectedKind, 'running',
        `Installed ${name} operation returned an invalid running job`);
      const phaseRank = phaseRanks[event.phase];
      invariant(phaseRank >= previousPhaseRank,
        `Installed ${name} operation reported phases out of order`);
      previousPhaseRank = phaseRank;
      if (event.phase === 'probing') {
        probingEvents += 1;
        invariant(index === 0
          && event.fraction === null
          && event.job.sequence === operation.initial.sequence
          && event.job.progress.basisPoints === operation.initial.progress.basisPoints,
        `Installed ${name} operation returned an invalid probing phase`);
      } else if (event.phase === 'processing') {
        invariant(event.job.progress.basisPoints <= PROCESSING_END_BASIS_POINTS,
          `Installed ${name} operation exceeded the processing progress range`);
      } else {
        publishingEvents += 1;
        invariant(event.fraction === null
          && event.job.progress.basisPoints === PUBLISHING_BASIS_POINTS,
        `Installed ${name} operation returned an invalid publishing phase`);
      }
    } else if (event.event === 'completed') {
      invariant(hasExactKeys(event, ['event', 'job', 'operation', 'result']),
        `Installed ${name} operation returned an invalid completion event`);
      assertJob(event.job, expectedKind, 'succeeded',
        `Installed ${name} operation did not succeed`);
      invariant(event === operation.events.at(-1),
        `Installed ${name} operation emitted data after completion`);
    } else {
      invariant(false, `Installed ${name} operation did not complete successfully`);
    }
    invariant(event.job.id === operation.initial.id
      && event.job.sequence >= previousSequence
      && event.job.progress.basisPoints >= previousProgress,
    `Installed ${name} job identity or progress regressed`);
    previousSequence = event.job.sequence;
    previousProgress = event.job.progress.basisPoints;
  });
  invariant(probingEvents === 1 && publishingEvents === 1,
    `Installed ${name} operation repeated or skipped a required native phase`);
  const terminal = operation.events.at(-1);
  invariant(terminal.event === 'completed' && terminal.job.progress.basisPoints === 10_000,
    `Installed ${name} operation did not reach terminal progress`);
  return terminal.result;
};

const assertMediaResult = (result, playbackProbe, {
  sourceId,
  displayName,
  extension,
  kind,
  mimeType,
  excludedIds,
  inspection,
}) => {
  invariant(hasExactKeys(result, ['kind', 'media', 'inspection'])
    && result.kind === 'media'
    && hasExactKeys(result.media, ['asset', 'playback']),
  `Installed ${displayName} operation returned invalid media data`);
  assertAsset(result.media.asset, { displayName, extension, kind, excludedIds });
  assertPlayback(result.media.playback, result.media.asset, mimeType);
  assertPlaybackProbe(playbackProbe, result.media.playback, {
    kind,
    duration: inspection.duration,
    width: inspection.width,
    height: inspection.height,
  });
  assertInspection(result.inspection, result.media.asset.id, inspection);
  if (sourceId !== null) {
    invariant(result.media.asset.id === sourceId,
      'Compatible playback preparation unexpectedly duplicated the source asset');
  }
  return result.media.asset;
};

const assertWaveform = (result, sourceId) => {
  invariant(hasExactKeys(result, ['kind', 'assetId', 'cacheHit', 'waveform'])
    && result.kind === 'waveform'
    && result.assetId === sourceId
    && typeof result.cacheHit === 'boolean'
    && hasExactKeys(result.waveform, ['durationUs', 'sourceSampleRateHz', 'levels'])
    && isBoundedInteger(
      result.waveform.durationUs,
      SOURCE_DURATION.minimum,
      SOURCE_DURATION.maximum,
    )
    && result.waveform.sourceSampleRateHz === 400
    && Array.isArray(result.waveform.levels)
    && result.waveform.levels.length >= 1 && result.waveform.levels.length <= 16,
  'Installed waveform generation returned an invalid bounded pyramid');
  let totalPoints = 0;
  let hasSignal = false;
  result.waveform.levels.forEach((level, index) => {
    invariant(hasExactKeys(level, ['pointsPerSecond', 'points'])
      && typeof level.pointsPerSecond === 'number'
      && Number.isFinite(level.pointsPerSecond)
      && level.pointsPerSecond > 0
      && (index !== 0 || level.pointsPerSecond === 100)
      && Array.isArray(level.points),
    'Installed waveform generation returned an invalid level');
    totalPoints += level.points.length;
    invariant(totalPoints <= 1_400_000,
      'Installed waveform generation exceeded its serialized point bound');
    for (const point of level.points) {
      invariant(hasExactKeys(point, ['minimum', 'maximum', 'rootMeanSquare'])
        && Number.isFinite(point.minimum)
        && Number.isFinite(point.maximum)
        && Number.isFinite(point.rootMeanSquare)
        && point.minimum >= -1 && point.maximum <= 1
        && point.minimum <= point.maximum
        && point.rootMeanSquare >= 0 && point.rootMeanSquare <= 1,
      'Installed waveform generation returned an invalid sample point');
      if (point.rootMeanSquare > 0.001) hasSignal = true;
    }
  });
  invariant(result.waveform.levels[0].points.length >= 390
    && result.waveform.levels[0].points.length <= 410
    && hasSignal,
  'Installed waveform generation did not preserve the four-second audio signal');
};

export function assertMediaPipelineResult(value, expectedSourceName) {
  invariant(findFilesystemLeaks(value).length === 0,
    'Installed media pipeline exposed a filesystem path across the renderer boundary');
  invariant(hasExactKeys(value, [
    'analysisClip', 'errorToastMessages', 'extractAudio', 'generateWaveform',
    'preparePlayback', 'source', 'sourceInspection',
  ]), 'Installed media pipeline returned an invalid result shape');
  invariant(Array.isArray(value.errorToastMessages) && value.errorToastMessages.length === 0,
    'Installed media pipeline displayed an error toast');
  invariant(hasExactKeys(value.source, ['asset', 'playback']),
    'Installed media pipeline did not retain an opaque selected source');
  assertAsset(value.source.asset, {
    displayName: expectedSourceName,
    extension: 'mp4',
    kind: 'video',
  });
  assertPlayback(value.source.playback, value.source.asset, 'video/mp4');
  assertInspection(value.sourceInspection, value.source.asset.id, {
    duration: SOURCE_DURATION,
    hasVideo: true,
    hasAudio: true,
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 640,
    height: 360,
  });

  const preparedResult = assertOperationEnvelope(
    value.preparePlayback,
    'preparePlayback',
    'processMedia',
  );
  assertMediaResult(preparedResult, value.preparePlayback.playbackProbe, {
    sourceId: value.source.asset.id,
    displayName: expectedSourceName,
    extension: 'mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    excludedIds: [],
    inspection: {
      duration: SOURCE_DURATION,
      hasVideo: true,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 640,
      height: 360,
    },
  });

  const clipResult = assertOperationEnvelope(value.analysisClip, 'analysisClip', 'processMedia');
  const clipAsset = assertMediaResult(clipResult, value.analysisClip.playbackProbe, {
    sourceId: null,
    displayName: 'analysis-clip.mp4',
    extension: 'mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    excludedIds: [value.source.asset.id],
    inspection: {
      duration: CLIP_DURATION,
      hasVideo: true,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 640,
      height: 360,
    },
  });

  const audioResult = assertOperationEnvelope(value.extractAudio, 'extractAudio', 'processMedia');
  assertMediaResult(audioResult, value.extractAudio.playbackProbe, {
    sourceId: null,
    displayName: 'extracted-audio.wav',
    extension: 'wav',
    kind: 'audio',
    mimeType: 'audio/wav',
    excludedIds: [value.source.asset.id, clipAsset.id],
    inspection: {
      duration: AUDIO_DURATION,
      hasVideo: false,
      hasAudio: true,
      videoCodec: null,
      audioCodec: 'pcm_s16le',
      width: null,
      height: null,
    },
  });

  const waveformResult = assertOperationEnvelope(
    value.generateWaveform,
    'generateWaveform',
    'generateWaveform',
  );
  invariant(value.generateWaveform.playbackProbe === null,
    'Waveform generation unexpectedly exposed a playback capability');
  assertWaveform(waveformResult, value.source.asset.id);
  return value;
}

export function summarizeMediaPipelineResult(value) {
  const terminal = (operation) => operation.events.at(-1).result;
  const prepared = terminal(value.preparePlayback).media.asset;
  const clip = terminal(value.analysisClip).media.asset;
  const audio = terminal(value.extractAudio).media.asset;
  const waveform = terminal(value.generateWaveform).waveform;
  return Object.freeze({
    sourceAssetId: value.source.asset.id,
    sourceDurationUs: value.sourceInspection.durationUs,
    compatibilityAction: value.sourceInspection.compatibilityAction,
    preparedAssetId: prepared.id,
    compatibilityZeroCopy: prepared.id === value.source.asset.id,
    clipAssetId: clip.id,
    clipDurationUs: terminal(value.analysisClip).inspection.durationUs,
    clipBytes: clip.sizeBytes,
    audioAssetId: audio.id,
    audioDurationUs: terminal(value.extractAudio).inspection.durationUs,
    audioBytes: audio.sizeBytes,
    waveformDurationUs: waveform.durationUs,
    waveformLevels: waveform.levels.length,
    waveformPoints: waveform.levels.reduce((sum, level) => sum + level.points.length, 0),
    capabilityChecks: 3,
  });
}
