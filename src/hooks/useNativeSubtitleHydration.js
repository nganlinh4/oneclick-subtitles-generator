import { useEffect } from 'react';

import { isDesktopRuntime } from '../platform/desktopRuntime';
import { loadProjectSubtitles } from '../platform/subtitleProjectStore';
import { readSubtitleImportProvenance } from '../platform/subtitleImportProvenance';
import {
  getCurrentCacheId,
  subscribeCurrentCacheId,
  subscribeCurrentSubtitleProjectRefresh,
} from '../utils/userSubtitlesStore';

/**
 * A native cache miss may preserve live rows only while an explicitly uploaded SRT is waiting for
 * its first media association. Once a media cache was already active, a miss belongs to the newly
 * selected media and must clear the previous media's rows.
 */
export const hasExplicitSrtFirstProvenance = ({
  previousCacheId,
  storage = globalThis.localStorage,
} = {}) => {
  if (previousCacheId !== null || !storage || typeof storage.getItem !== 'function') return false;
  return readSubtitleImportProvenance({ storage })?.cacheId === null;
};

export const createNativeSubtitleHydrator = ({
  load = loadProjectSubtitles,
  readCurrentCacheId = getCurrentCacheId,
  readRevision,
  apply,
  preserveOnMiss = hasExplicitSrtFirstProvenance,
  onFailure = () => undefined,
}) => {
  if (typeof load !== 'function' || typeof readCurrentCacheId !== 'function'
      || typeof readRevision !== 'function' || typeof apply !== 'function'
      || typeof preserveOnMiss !== 'function' || typeof onFailure !== 'function') {
    throw new TypeError('Native subtitle hydration requires reviewed dependencies');
  }

  let generation = 0;
  let disposed = false;

  const isCurrentRequest = (cacheId, requestedGeneration, startingRevision) => (
    !disposed
    && requestedGeneration === generation
    && readCurrentCacheId() === cacheId
    && readRevision() === startingRevision
  );

  const clearPriorMediaOnFailure = (
    cacheId,
    previousCacheId,
    requestedGeneration,
    startingRevision,
    alreadyCleared
  ) => {
    if (!isCurrentRequest(cacheId, requestedGeneration, startingRevision)
        || typeof previousCacheId !== 'string'
        || previousCacheId.length === 0
        || previousCacheId === cacheId) {
      return false;
    }
    if (!alreadyCleared) apply(null);
    return true;
  };

  const reportCurrentFailure = (cacheId, requestedGeneration, startingRevision) => {
    if (!isCurrentRequest(cacheId, requestedGeneration, startingRevision)) return;
    try {
      onFailure(Object.freeze({ code: 'subtitleHydrationFailed', cacheId }));
    } catch {
      // Notification delivery cannot make stale rows authoritative again.
    }
  };

  const activate = async (cacheId, { previousCacheId } = {}) => {
    generation += 1;
    const requestedGeneration = generation;
    if (typeof cacheId !== 'string' || cacheId.length === 0) return false;
    const clearsPriorMedia = typeof previousCacheId === 'string'
      && previousCacheId.length > 0
      && previousCacheId !== cacheId;
    if (clearsPriorMedia) apply(null);
    const startingRevision = readRevision();

    let rows;
    try {
      rows = await load(cacheId);
    } catch {
      const wasCurrent = isCurrentRequest(cacheId, requestedGeneration, startingRevision);
      clearPriorMediaOnFailure(
        cacheId,
        previousCacheId,
        requestedGeneration,
        startingRevision,
        clearsPriorMedia
      );
      if (wasCurrent) {
        try { onFailure(Object.freeze({ code: 'subtitleHydrationFailed', cacheId })); } catch {
          // Notification delivery cannot make stale rows authoritative again.
        }
      }
      return false;
    }

    if (!isCurrentRequest(cacheId, requestedGeneration, startingRevision)) {
      return false;
    }

    if (rows === null) {
      let shouldPreserve = false;
      try {
        shouldPreserve = preserveOnMiss({ cacheId, previousCacheId }) === true;
      } catch {
        // A missing or malformed provenance signal is not authority to retain another media's rows.
      }
      if (shouldPreserve) return false;
      if (!clearsPriorMedia) apply(null);
      return true;
    }

    if (!Array.isArray(rows)) {
      reportCurrentFailure(cacheId, requestedGeneration, startingRevision);
      clearPriorMediaOnFailure(
        cacheId,
        previousCacheId,
        requestedGeneration,
        startingRevision,
        clearsPriorMedia
      );
      return false;
    }
    apply(rows);
    return true;
  };

  return Object.freeze({
    activate,
    dispose: () => {
      disposed = true;
      generation += 1;
    },
  });
};

export const useNativeSubtitleHydration = ({ setSubtitlesData, revisionRef, t }) => {
  useEffect(() => {
    if (!isDesktopRuntime()) return undefined;
    const hydrator = createNativeSubtitleHydrator({
      readRevision: () => revisionRef.current,
      apply: setSubtitlesData,
      onFailure: () => window.addToast?.(
        t(
          'output.subtitlesCacheLoadFailed',
          'Media is ready, but saved subtitles could not be loaded.'
        ),
        'error',
        8_000,
        'subtitle-hydration-failed'
      ),
    });
    const activate = (cacheId, previousCacheId) => {
      void hydrator.activate(cacheId, { previousCacheId });
    };
    const unsubscribe = subscribeCurrentCacheId(activate);
    const unsubscribeRefresh = subscribeCurrentSubtitleProjectRefresh((cacheId) => {
      activate(cacheId, cacheId);
    });
    const initialCacheId = getCurrentCacheId();
    activate(initialCacheId, initialCacheId);
    return () => {
      unsubscribe();
      unsubscribeRefresh();
      hydrator.dispose();
    };
  }, [revisionRef, setSubtitlesData, t]);
};
