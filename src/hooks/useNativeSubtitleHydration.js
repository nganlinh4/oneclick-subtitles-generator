import { useEffect } from 'react';

import { isDesktopRuntime } from '../platform/desktopRuntime';
import { loadProjectSubtitles } from '../platform/subtitleProjectStore';
import {
  getCurrentCacheId,
  subscribeCurrentCacheId,
} from '../utils/userSubtitlesStore';

const UPLOADED_SRT_INFO_KEYS = Object.freeze(['fileName', 'hasUploaded', 'source']);
const MAX_UPLOADED_SRT_FILE_NAME_CHARACTERS = 512;

const isRecord = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const hasExactKeys = (value, expectedKeys) => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
};

const hasControlCharacter = (value) => Array.from(value).some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 31 || codePoint === 127;
});

const isSafeUploadedSrtFileName = (value) => (
  typeof value === 'string'
  && value === value.trim()
  && value.length > 0
  && Array.from(value).length <= MAX_UPLOADED_SRT_FILE_NAME_CHARACTERS
  && !hasControlCharacter(value)
  && !value.includes('/')
  && !value.includes('\\')
);

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
  try {
    const raw = storage.getItem('uploaded_srt_info');
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return false;
    const info = JSON.parse(raw);
    return hasExactKeys(info, UPLOADED_SRT_INFO_KEYS)
      && info.hasUploaded === true
      && info.source === 'srt'
      && isSafeUploadedSrtFileName(info.fileName);
  } catch {
    return false;
  }
};

export const createNativeSubtitleHydrator = ({
  load = loadProjectSubtitles,
  readCurrentCacheId = getCurrentCacheId,
  readRevision,
  apply,
  preserveOnMiss = hasExplicitSrtFirstProvenance,
}) => {
  if (typeof load !== 'function' || typeof readCurrentCacheId !== 'function'
      || typeof readRevision !== 'function' || typeof apply !== 'function'
      || typeof preserveOnMiss !== 'function') {
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
      return clearPriorMediaOnFailure(
        cacheId,
        previousCacheId,
        requestedGeneration,
        startingRevision,
        clearsPriorMedia
      );
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
      return clearPriorMediaOnFailure(
        cacheId,
        previousCacheId,
        requestedGeneration,
        startingRevision,
        clearsPriorMedia
      );
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

export const useNativeSubtitleHydration = ({ setSubtitlesData, revisionRef }) => {
  useEffect(() => {
    if (!isDesktopRuntime()) return undefined;
    const hydrator = createNativeSubtitleHydrator({
      readRevision: () => revisionRef.current,
      apply: setSubtitlesData,
    });
    const activate = (cacheId, previousCacheId) => {
      void hydrator.activate(cacheId, { previousCacheId });
    };
    const unsubscribe = subscribeCurrentCacheId(activate);
    const initialCacheId = getCurrentCacheId();
    activate(initialCacheId, initialCacheId);
    return () => {
      unsubscribe();
      hydrator.dispose();
    };
  }, [revisionRef, setSubtitlesData]);
};
