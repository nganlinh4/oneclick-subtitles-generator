import { useEffect, useRef } from 'react';

import { nativeNarrationAdapter } from '../../../platform/nativeNarrationAdapter';
import { acknowledgeJobResult } from '../../../platform/jobResultDeliveryService';
import {
  getActiveProjectSnapshot,
  subscribeToActiveProject,
} from '../../../platform/projectService';
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

    return undefined;
  }, []);

  useEffect(() => {
    let disposed = false;
    let sequence = 0;
    let activeProjectId = null;
    let activePlayback = null;

    const release = (reference) => {
      if (!reference?.nativePlaybackId) return;
      nativeNarrationAdapter.releasePlayback(reference).catch(() => undefined);
    };

    const publish = (snapshot, reference) => {
      const artifactId = getNativeNarrationArtifactId(reference);
      const normalized = {
        ...reference,
        projectId: snapshot.metadata.id,
        projectStateVersion: snapshot.stateVersion,
        nativeArtifactId: artifactId,
        filename: createNativeNarrationToken(artifactId),
        url: reference.audioUrl,
        text: reference.text || '',
        language: reference.language || 'Unknown',
        fromCache: true,
      };
      activePlayback = normalized;
      current.current.setReferenceAudio(normalized);
      current.current.setReferenceText(normalized.text);
    };

    const hydrate = async (snapshot) => {
      const operation = ++sequence;
      if (!snapshot?.metadata?.id) {
        activeProjectId = null;
        release(activePlayback);
        activePlayback = null;
        current.current.setReferenceAudio(null);
        current.current.setReferenceText('');
        return;
      }
      if (activeProjectId === snapshot.metadata.id) {
        current.current.setReferenceAudio((previous) => previous && ({
          ...previous,
          projectStateVersion: snapshot.stateVersion,
        }));
        return;
      }
      activeProjectId = snapshot.metadata.id;
      release(activePlayback);
      activePlayback = null;
      current.current.setReferenceAudio(null);
      current.current.setReferenceText('');
      try {
        let reference = await nativeNarrationAdapter.getReference(snapshot.metadata.id);
        const latest = getActiveProjectSnapshot();
        if (disposed || operation !== sequence
            || latest?.metadata?.id !== snapshot.metadata.id) {
          release(reference);
          return;
        }
        if (reference?.pendingDelivery) {
          try {
            await acknowledgeJobResult(
              reference.pendingDelivery.jobId,
              reference.pendingDelivery.deliveryId,
            );
            const confirmed = getActiveProjectSnapshot();
            if (confirmed?.metadata?.id === snapshot.metadata.id) {
              const cleared = await nativeNarrationAdapter.commitReference({
                projectId: snapshot.metadata.id,
                expectedProjectStateVersion: confirmed.stateVersion,
                expectedReferenceVersion: reference.referenceVersion,
                artifactId: reference.nativeArtifactId,
                transcript: reference.text,
                language: reference.language,
                deliveryJobId: null,
                deliveryId: null,
              });
              reference = Object.freeze({
                ...reference,
                referenceVersion: cleared.referenceVersion,
                pendingDelivery: null,
              });
            }
          } catch {
            // Both native records retain the exact delivery for the next hydration attempt.
          }
        }
        const finalSnapshot = getActiveProjectSnapshot();
        if (reference && finalSnapshot?.metadata?.id === snapshot.metadata.id) {
          publish(finalSnapshot, reference);
        } else {
          release(reference);
        }
      } catch {
        // A missing or corrupt native artifact refuses restoration without reviving legacy data.
      }
    };

    void hydrate(getActiveProjectSnapshot());
    const unsubscribe = subscribeToActiveProject((snapshot) => { void hydrate(snapshot); });
    return () => {
      disposed = true;
      sequence += 1;
      unsubscribe();
      release(activePlayback);
    };
  }, []);
};

export default useNarrationCache;
