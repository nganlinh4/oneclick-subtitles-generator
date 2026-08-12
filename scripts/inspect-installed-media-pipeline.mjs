import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { CdpClient, discoverTarget } from './inspect-installed-webview.mjs';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAYBACK_URL = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/asset\/([0-9a-f-]{36})\?token=([0-9a-f]{64})$/i;
const SOURCE_DURATION = Object.freeze({ minimum: 3_900_000, maximum: 4_100_000 });
const CLIP_DURATION = Object.freeze({ minimum: 1_400_000, maximum: 1_600_000 });
const AUDIO_DURATION = Object.freeze({ minimum: 1_900_000, maximum: 2_100_000 });
const PHASES = new Set(['probing', 'processing', 'publishing']);
const MAX_OPERATION_EVENTS = 4_096;
const PROCESSING_END_BASIS_POINTS = 9_500;
const PUBLISHING_BASIS_POINTS = 9_700;

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const hasExactKeys = (value, keys) => value && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

const isBoundedInteger = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => (
  Number.isSafeInteger(value) && value >= minimum && value <= maximum
);

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(/^--[a-z-]+$/.test(key ?? '') && value !== undefined,
      'Usage: inspect-installed-media-pipeline.mjs --port PORT --expected-source-name NAME');
    invariant(!values.has(key), `Duplicate argument: ${key}`);
    values.set(key, value);
  }
  invariant(values.size === 2, 'Only reviewed installed media-pipeline arguments are accepted');
  const port = Number(values.get('--port'));
  invariant(Number.isInteger(port) && port >= 1_024 && port <= 65_535,
    'DevTools port must be an unprivileged TCP port');
  const expectedSourceName = values.get('--expected-source-name');
  invariant(typeof expectedSourceName === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mp4$/.test(expectedSourceName),
  'Expected media-pipeline source name is invalid');
  return Object.freeze({ port, expectedSourceName });
}

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
  invariant(hasExactKeys(result, ['kind', 'assetId', 'waveform'])
    && result.kind === 'waveform'
    && result.assetId === sourceId
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

const evaluate = async (client, expression) => {
  const evaluation = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  invariant(!evaluation.exceptionDetails,
    'Installed media-pipeline evaluation failed inside the WebView');
  return evaluation.result?.value;
};

export const PIPELINE_EXPRESSION = `
(async () => {
  const internals = window.__TAURI_INTERNALS__;
  const invoke = internals?.invoke;
  if (typeof invoke !== 'function'
      || typeof internals.transformCallback !== 'function'
      || typeof internals.unregisterCallback !== 'function') {
    throw new Error('The installed desktop IPC channel is unavailable');
  }
  const session = await invoke('get_session_snapshot');
  if (!session?.media?.id || !session?.playback?.playbackUrl) {
    throw new Error('The installed media pipeline has no selected native source');
  }
  const sourceId = session.media.id;
  const maxChannelPackets = ${MAX_OPERATION_EVENTS};

  const createChannel = (onMessage, onEnd, onProtocolError) => {
    let nextIndex = 0;
    let endIndex = null;
    const pending = new Map();
    let callbackId = null;
    const cleanup = () => {
      if (callbackId !== null) internals.unregisterCallback(callbackId);
    };
    const drain = () => {
      while (pending.has(nextIndex)) {
        const message = pending.get(nextIndex);
        pending.delete(nextIndex);
        nextIndex += 1;
        onMessage(message);
      }
      if (endIndex === nextIndex) {
        cleanup();
        onEnd();
      }
    };
    callbackId = internals.transformCallback((packet) => {
      if (!packet
          || !Number.isSafeInteger(packet.index)
          || packet.index < nextIndex
          || packet.index > maxChannelPackets) {
        cleanup();
        onProtocolError();
        return;
      }
      if (Object.prototype.hasOwnProperty.call(packet, 'end')) {
        endIndex = packet.index;
        drain();
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(packet, 'message')
          || pending.has(packet.index)
          || pending.size >= maxChannelPackets) {
        cleanup();
        onProtocolError();
        return;
      }
      pending.set(packet.index, packet.message);
      drain();
    }, false);
    return '__CHANNEL__:' + callbackId;
  };

  const runOperation = async (request) => {
    let initial = null;
    let terminalEvent = null;
    let channelEnded = false;
    let settled = false;
    let resolveTerminal;
    let rejectTerminal;
    const events = [];
    const terminal = new Promise((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    const succeedIfReady = () => {
      if (!settled && initial !== null && terminalEvent !== null && channelEnded) {
        settled = true;
        resolveTerminal();
      }
    };
    const fail = (message) => {
      if (settled) return;
      settled = true;
      rejectTerminal(new Error(message));
    };
    const channel = createChannel((event) => {
      if (terminalEvent !== null) {
        fail('The installed media channel emitted data after completion');
        return;
      }
      if (events.length >= maxChannelPackets) {
        fail('The installed media channel exceeded its event bound');
        return;
      }
      events.push(event);
      if (event?.event === 'failed' || event?.event === 'cancelled') {
        fail('The installed ' + request.operation + ' operation did not succeed');
        return;
      }
      if (event?.event === 'completed') {
        terminalEvent = event;
        succeedIfReady();
      }
    }, () => {
      if (terminalEvent === null) {
        fail('The installed media channel ended before completion');
        return;
      }
      channelEnded = true;
      succeedIfReady();
    }, () => fail('The installed media channel returned an invalid packet'));
    const timer = setTimeout(() => {
      if (initial?.id) void invoke('media_pipeline_cancel', { jobId: initial.id });
      fail('The installed ' + request.operation + ' operation timed out');
    }, 120000);
    try {
      initial = await invoke('media_pipeline_start', { request, onEvent: channel });
      succeedIfReady();
      await terminal;
      return { events, initial, playbackProbe: null };
    } finally {
      clearTimeout(timer);
    }
  };

  const probePlayback = async (operation) => {
    const result = operation.events.at(-1)?.result;
    const playback = result?.media?.playback;
    if (!playback?.playbackUrl) throw new Error('A derived playback capability is missing');
    const kind = playback.mimeType?.startsWith('video/') ? 'video'
      : playback.mimeType?.startsWith('audio/') ? 'audio' : null;
    if (kind === null) throw new Error('A derived playback MIME kind is invalid');
    const media = document.createElement(kind);
    media.preload = 'auto';
    media.muted = true;
    let metadataLoaded = false;
    let canPlay = false;
    const observed = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('A derived playback capability did not become playable')),
        30000,
      );
      const finish = () => {
        if (!metadataLoaded || !canPlay) return;
        clearTimeout(timeout);
        resolve({
          canPlay,
          duration: media.duration,
          height: kind === 'video' ? media.videoHeight : null,
          kind,
          metadataLoaded,
          readyState: media.readyState,
          width: kind === 'video' ? media.videoWidth : null,
        });
      };
      media.addEventListener('loadedmetadata', () => {
        metadataLoaded = true;
        finish();
      }, { once: true });
      media.addEventListener('canplay', () => {
        canPlay = true;
        finish();
      }, { once: true });
      media.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('A derived playback capability could not be decoded'));
      }, { once: true });
      media.src = playback.playbackUrl;
      media.load();
    }).finally(() => {
      media.pause();
      media.removeAttribute('src');
      media.load();
      media.remove();
    });
    operation.playbackProbe = observed;
    return operation;
  };

  const sourceInspection = await invoke('media_pipeline_inspect', { assetId: sourceId });
  const preparePlayback = await probePlayback(await runOperation({
    operation: 'preparePlayback',
    assetId: sourceId,
  }));
  const analysisClip = await probePlayback(await runOperation({
    operation: 'analysisClip',
    assetId: sourceId,
    startUs: 750000,
    endUs: 2250000,
  }));
  const extractAudio = await probePlayback(await runOperation({
    operation: 'extractAudio',
    assetId: sourceId,
    format: 'wav',
    startUs: 500000,
    endUs: 2500000,
  }));
  const generateWaveform = await runOperation({
    operation: 'generateWaveform',
    assetId: sourceId,
    pointsPerSecond: 100,
    maxPoints: 1000,
    startUs: 0,
    endUs: null,
  });

  return {
    analysisClip,
    errorToastMessages: [...document.querySelectorAll('.toast-error p')]
      .slice(0, 4)
      .map((element) => (element.textContent ?? '').trim().slice(0, 1024)),
    extractAudio,
    generateWaveform,
    preparePlayback,
    source: { asset: session.media, playback: session.playback },
    sourceInspection,
  };
})()`;

async function runInstalledMediaPipeline(options) {
  const target = await discoverTarget(options.port);
  const client = new CdpClient(target.webSocketDebuggerUrl, DEFAULT_TIMEOUT_MS);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    const result = await evaluate(client, PIPELINE_EXPRESSION);
    assertMediaPipelineResult(result, options.expectedSourceName);
    return summarizeMediaPipelineResult(result);
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => runInstalledMediaPipeline(parseArguments(process.argv.slice(2))))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error
        ? error.message
        : 'Installed media pipeline inspection failed'}\n`);
      process.exitCode = 1;
    });
}
