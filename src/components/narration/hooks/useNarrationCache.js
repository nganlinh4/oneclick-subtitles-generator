import { useEffect, useRef } from 'react';

import { nativeNarrationAdapter } from '../../../platform/nativeNarrationAdapter';
import {
  createNativeNarrationToken,
  getNativeNarrationArtifactId,
} from '../../../platform/nativeNarrationCapabilities';
import { getCurrentMediaId } from './referenceAudioCache';

const CACHE_KEYS = Object.freeze([
  'f5tts_narrations_cache',
  'chatterbox_narrations_cache',
  'edge_tts_narrations_cache',
  'gtts_narrations_cache',
  'gemini_narration_cache',
]);
const REFERENCE_KEYS = Object.freeze([
  'reference_audio_cache',
  'f5tts_narrations_cache',
  'chatterbox_narrations_cache',
]);
const MAX_CACHE_BYTES = 4 * 1024 * 1024;

const readCache = (key, mediaId) => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > MAX_CACHE_BYTES) return null;
    const value = JSON.parse(raw);
    return value?.mediaId === mediaId && Number.isSafeInteger(value.timestamp)
      ? value
      : null;
  } catch {
    return null;
  }
};

const sanitizeNarration = (result) => {
  const artifactId = getNativeNarrationArtifactId(result);
  if (!artifactId || !result || typeof result !== 'object') return null;
  return {
    subtitle_id: result.subtitle_id,
    filename: createNativeNarrationToken(artifactId),
    nativeArtifactId: artifactId,
    nativeFormat: result.nativeFormat,
    durationMicros: result.durationMicros,
    success: result.success === true,
    pending: result.pending === true,
    text: typeof result.text === 'string' ? result.text : '',
    method: result.method,
    outputIndex: result.outputIndex,
    original_ids: Array.isArray(result.original_ids) ? [...result.original_ids] : undefined,
    start: result.start,
    end: result.end,
  };
};

const newest = (entries) => entries
  .filter(Boolean)
  .sort((left, right) => right.timestamp - left.timestamp)[0] || null;

const useNarrationCache = ({
  generationResults,
  setGenerationResults,
  setGenerationStatus,
  subtitleSource,
  t,
  setReferenceAudio,
  setReferenceText,
}) => {
  const current = useRef({
    generationResults,
    subtitleSource,
    setGenerationResults,
    setGenerationStatus,
    setReferenceAudio,
    setReferenceText,
    t,
  });
  current.current = {
    generationResults,
    subtitleSource,
    setGenerationResults,
    setGenerationStatus,
    setReferenceAudio,
    setReferenceText,
    t,
  };

  useEffect(() => {
    let disposed = false;
    const mediaId = getCurrentMediaId();
    if (!mediaId) return undefined;

    const narrationEntry = newest(CACHE_KEYS.map((key) => readCache(key, mediaId)));
    const narrations = Array.isArray(narrationEntry?.narrations)
      ? narrationEntry.narrations.map(sanitizeNarration).filter(Boolean)
      : [];
    if (narrations.length > 0 && current.current.generationResults.length === 0) {
      current.current.setGenerationResults(narrations);
      current.current.setGenerationStatus(current.current.t(
        'narration.loadedFromCache',
        'Loaded narrations from previous session',
      ));
      const grouped = narrations.some((result) => result.original_ids?.length > 1);
      window.useGroupedSubtitles = grouped;
      if (grouped) window.groupedNarrations = [...narrations];
      else if (current.current.subtitleSource === 'translated') {
        window.translatedNarrations = [...narrations];
      } else {
        window.originalNarrations = [...narrations];
      }
    }

    const referenceEntry = newest(REFERENCE_KEYS.map((key) => readCache(key, mediaId)));
    const reference = referenceEntry?.referenceAudio;
    const artifactId = getNativeNarrationArtifactId(reference);
    if (!artifactId) return undefined;
    nativeNarrationAdapter.resolvePlayback(artifactId).then((playable) => {
      if (disposed) {
        nativeNarrationAdapter.releasePlayback(playable).catch(() => undefined);
        return;
      }
      current.current.setReferenceAudio({
        nativeArtifactId: artifactId,
        nativePlaybackId: playable.nativePlaybackId,
        filename: createNativeNarrationToken(artifactId),
        url: playable.audioUrl,
        audioUrl: playable.audioUrl,
        mimeType: playable.mimeType,
        format: playable.format,
        durationMicros: playable.durationMicros,
        text: typeof reference.text === 'string' ? reference.text : '',
        language: reference.language,
        fromCache: true,
      });
      current.current.setReferenceText(
        typeof reference.text === 'string' ? reference.text : '',
      );
    }).catch(() => undefined);

    return () => { disposed = true; };
  }, []);
};

export default useNarrationCache;
