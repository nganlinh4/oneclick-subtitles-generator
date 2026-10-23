// Validation of the WebView's media pipeline requests, Channel handlers and run options.
import {
  audioFormats,
  invalidRequest,
  isFiniteNumber,
  isSafeInteger,
  MAX_DURATION_US,
  MAX_WAVEFORM_POINTS,
  operations,
  requireAssetId,
} from './mediaPipelineContract';
import { exactRecord, snapshotDataRecord } from './nativeDataSnapshot';
import { hasExactKeys } from './plainDataRecord';

const secondsToMicroseconds = (value) => {
  if (!isFiniteNumber(value) || value < 0 || value > MAX_DURATION_US / 1_000_000) {
    throw invalidRequest();
  }
  const microseconds = Math.round(value * 1_000_000);
  if (!isSafeInteger(microseconds, 0, MAX_DURATION_US)) throw invalidRequest();
  return microseconds;
};

const normalizeRange = (value, { optional = false } = {}) => {
  if (optional && (value === null || value === undefined)) return null;
  const data = exactRecord(value, ['start', 'end'], invalidRequest);
  const startUs = secondsToMicroseconds(data.start);
  const endUs = secondsToMicroseconds(data.end);
  if (endUs <= startUs) throw invalidRequest();
  return Object.freeze({ startUs, endUs });
};

export const normalizeMediaPipelineRequest = (request) => {
  const data = snapshotDataRecord(request, {
    required: ['operation', 'assetId'],
    allowed: ['operation', 'assetId', 'range', 'format', 'pointsPerSecond', 'maxPoints'],
    failure: invalidRequest,
  });
  if (!operations.has(data.operation)) throw invalidRequest();
  switch (data.operation) {
    case 'preparePlayback':
      if (!hasExactKeys(data, ['operation', 'assetId'])) throw invalidRequest();
      return Object.freeze({ operation: data.operation, assetId: requireAssetId(data.assetId) });
    case 'analysisClip': {
      if (!hasExactKeys(data, ['operation', 'assetId', 'range'])) throw invalidRequest();
      const range = normalizeRange(data.range);
      return Object.freeze({
        operation: data.operation,
        assetId: requireAssetId(data.assetId),
        startUs: range.startUs,
        endUs: range.endUs,
      });
    }
    case 'extractAudio': {
      if (!hasExactKeys(data, ['operation', 'assetId', 'format', 'range'])
          || !audioFormats.has(data.format)) {
        throw invalidRequest();
      }
      const range = normalizeRange(data.range, { optional: true });
      return Object.freeze({
        operation: data.operation,
        assetId: requireAssetId(data.assetId),
        format: data.format,
        startUs: range === null ? 0 : range.startUs,
        endUs: range === null ? null : range.endUs,
      });
    }
    case 'generateWaveform': {
      if (!hasExactKeys(data, [
        'operation', 'assetId', 'range', 'pointsPerSecond', 'maxPoints',
      ])
          || !isSafeInteger(data.pointsPerSecond, 1, 400)
          || !isSafeInteger(data.maxPoints, 1_000, MAX_WAVEFORM_POINTS)) {
        throw invalidRequest();
      }
      const range = normalizeRange(data.range, { optional: true });
      return Object.freeze({
        operation: data.operation,
        assetId: requireAssetId(data.assetId),
        pointsPerSecond: data.pointsPerSecond,
        maxPoints: data.maxPoints,
        startUs: range === null ? 0 : range.startUs,
        endUs: range === null ? null : range.endUs,
      });
    }
    default:
      throw invalidRequest();
  }
};

export const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  const allowed = [
    'onEvent', 'onProgress', 'onCompleted', 'onCancelled', 'onFailed', 'onProtocolError',
  ];
  const data = snapshotDataRecord(handlers, {
    required: [],
    allowed,
    failure: invalidRequest,
  });
  for (const handler of Object.values(data)) {
    if (handler !== undefined && typeof handler !== 'function') throw invalidRequest();
  }
  return data;
};

export const normalizeRunOptions = (options) => {
  if (options === undefined) return Object.freeze({});
  const data = snapshotDataRecord(options, {
    required: [],
    allowed: ['signal', 'onProgress'],
    failure: invalidRequest,
  });
  if (data.onProgress !== undefined && typeof data.onProgress !== 'function') {
    throw invalidRequest();
  }
  let signal;
  if (data.signal !== undefined) {
    try {
      const rawSignal = data.signal;
      const addEventListener = rawSignal.addEventListener;
      const removeEventListener = rawSignal.removeEventListener;
      if (typeof addEventListener !== 'function' || typeof removeEventListener !== 'function') {
        throw invalidRequest();
      }
      signal = Object.freeze({
        readAborted: () => {
          try {
            const aborted = rawSignal.aborted;
            if (typeof aborted !== 'boolean') throw invalidRequest();
            return aborted;
          } catch {
            throw invalidRequest();
          }
        },
        addEventListener: (...args) => Reflect.apply(addEventListener, rawSignal, args),
        removeEventListener: (...args) => Reflect.apply(removeEventListener, rawSignal, args),
      });
    } catch {
      throw invalidRequest();
    }
  }
  return Object.freeze({ signal, onProgress: data.onProgress });
};
