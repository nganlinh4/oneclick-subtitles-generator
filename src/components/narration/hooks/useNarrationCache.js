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
import { loadProjectNarration } from '../../../platform/projectNarrationStore';

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
    let sequence = 0;
    const hydrate = async (snapshot) => {
      const operation = ++sequence;
      const projectId = snapshot?.metadata?.id;
      if (!projectId) return;
      try {
        const stored = await loadProjectNarration(projectId);
        const latest = getActiveProjectSnapshot();
        if (disposed || operation !== sequence || stored === null
            || latest?.metadata?.id !== stored.projectId
            || latest.stateVersion !== stored.projectStateVersion
            || current.current.generationResults.length > 0) return;
        current.current.setGenerationResults(stored.results);
        current.current.setGenerationStatus(current.current.t(
          'narration.loadedFromCache',
          'Loaded narrations from previous session',
        ));
      } catch {
        // Corrupt or stale native records never revive browser cache data.
      }
    };
    void hydrate(getActiveProjectSnapshot());
    const unsubscribe = subscribeToActiveProject((snapshot) => { void hydrate(snapshot); });
    return () => {
      disposed = true;
      sequence += 1;
      unsubscribe();
    };
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
