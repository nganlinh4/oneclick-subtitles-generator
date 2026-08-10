import { nativeNarrationAdapter } from './nativeNarrationAdapter';
import { exportSpeechArtifacts } from './speechService';
import {
  attachNativeNarrationArtifact,
  getNativeNarrationArtifactId,
  isNativeNarrationResult,
} from './nativeNarrationCapabilities';

const safeSubtitleName = (value, index) => {
  const text = String(value ?? index + 1).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return text || String(index + 1);
};

const safeFormat = (result) => (
  ['wav', 'mp3', 'm4a'].includes(result?.nativeFormat)
    ? result.nativeFormat
    : (['wav', 'mp3', 'm4a'].includes(result?.format) ? result.format : 'wav')
);

const safeSuggestedName = (value, fallbackStem, extension) => {
  const suffix = `.${extension}`;
  const candidate = typeof value === 'string' && value.toLowerCase().endsWith(suffix)
    ? value.slice(0, -suffix.length)
    : fallbackStem;
  return `${safeSubtitleName(candidate, 0)}${suffix}`;
};

const exportEntries = (narrations) => {
  const usedNames = new Set();
  return narrations.map((result, index) => {
    const extension = safeFormat(result);
    const stem = `narration_${safeSubtitleName(result.subtitle_id, index)}`;
    let fileName = `${stem}.${extension}`;
    let suffix = 2;
    while (usedNames.has(fileName)) {
      fileName = `${stem}_${suffix}.${extension}`;
      suffix += 1;
    }
    usedNames.add(fileName);
    return Object.freeze({
      artifactId: getNativeNarrationArtifactId(result),
      fileName,
    });
  });
};

export const resolveNativeNarrationPlayback = (result) => (
  nativeNarrationAdapter.resolvePlayback(getNativeNarrationArtifactId(result))
);

export const releaseNativeNarrationPlayback = (playable) => (
  playable?.nativePlaybackId
    ? nativeNarrationAdapter.releasePlayback(playable).catch(() => false)
    : Promise.resolve(false)
);

export const downloadNativeNarration = async (result, suggestedName = null) => {
  if (!isNativeNarrationResult(result)) throw new Error('Native narration audio is unavailable');
  const extension = safeFormat(result);
  const fallbackStem = `narration_${safeSubtitleName(result.subtitle_id, 0)}`;
  return exportSpeechArtifacts({
    entries: [Object.freeze({
      artifactId: getNativeNarrationArtifactId(result),
      fileName: safeSuggestedName(suggestedName, fallbackStem, extension),
    })],
    archiveName: null,
  });
};

export const downloadNativeNarrations = async (results) => {
  const narrations = Array.isArray(results) ? results.filter(isNativeNarrationResult) : [];
  if (narrations.length === 0 || narrations.length > 1_000) {
    throw new Error('Native narration audio is unavailable');
  }
  return exportSpeechArtifacts({
    entries: exportEntries(narrations),
    archiveName: 'narration_audio.zip',
  });
};

export const editNativeNarration = async (result, {
  normalizedStart = 0,
  normalizedEnd = 1,
  speedFactor = 1,
} = {}) => {
  const artifactId = getNativeNarrationArtifactId(result);
  if (!artifactId) throw new Error('Native narration audio is unavailable');
  const artifact = await nativeNarrationAdapter.editArtifact({
    artifactId,
    normalizedStart,
    normalizedEnd,
    speedFactor,
  });
  return attachNativeNarrationArtifact(result, artifact);
};
