import { useEffect, useState } from 'react';

import {
  bindPendingSubtitleImportProvenance,
  clearSubtitleImportProvenance,
  readSubtitleImportProvenance,
  writeSubtitleImportProvenance,
} from '../../../platform/subtitleImportProvenance';
import {
  getCurrentCacheId,
  subscribeCurrentCacheId,
} from '../../../utils/userSubtitlesStore';

const EMPTY_INFO = Object.freeze({ hasUploaded: false, fileName: '', source: '' });

const uiInfo = (provenance, cacheId) => (
  provenance !== null && provenance.cacheId === cacheId
    ? Object.freeze({ hasUploaded: true, fileName: provenance.fileName, source: 'srt' })
    : EMPTY_INFO
);

/**
 * Track explicit user imports as presentation metadata only. Subtitle rows and clearing remain
 * owned by the exact native project; this hook publishes a filename only after those operations
 * return typed success. The metadata is scoped to the project alias so switching projects cannot
 * make one project's import badge or export filename leak into another.
 */
export const useSrtUploadState = ({
  subtitlesData,
  handleSrtUpload,
  handleSrtClear,
}) => {
  const [uploadedSrtInfo, setUploadedSrtInfo] = useState(() => (
    uiInfo(readSubtitleImportProvenance(), getCurrentCacheId())
  ));

  useEffect(() => subscribeCurrentCacheId((cacheId) => {
    let provenance = readSubtitleImportProvenance();
    if (cacheId !== null
        && provenance?.cacheId === null
        && Array.isArray(subtitlesData)
        && subtitlesData.length > 0) {
      provenance = bindPendingSubtitleImportProvenance(cacheId);
    }
    setUploadedSrtInfo(uiInfo(provenance, cacheId));
  }), [subtitlesData]);

  const handleSrtUploadWithState = async (content, fileName) => {
    const result = await handleSrtUpload(content, fileName);
    if (result?.status !== 'accepted') return result;

    const activeCacheId = getCurrentCacheId() ?? null;
    const receiptCacheId = result.persistence?.cacheId;
    if (typeof receiptCacheId === 'string' && receiptCacheId !== activeCacheId) return result;
    const cacheId = receiptCacheId ?? activeCacheId;
    writeSubtitleImportProvenance({ cacheId, fileName });
    setUploadedSrtInfo(uiInfo({ cacheId, fileName }, cacheId));
    return result;
  };

  const handleSrtClearWithState = async () => {
    const result = await handleSrtClear();
    if (result?.status !== 'cleared') return result;

    const expectedCacheId = result.persistence?.cacheId ?? getCurrentCacheId() ?? null;
    clearSubtitleImportProvenance({ expectedCacheId });
    setUploadedSrtInfo(uiInfo(readSubtitleImportProvenance(), getCurrentCacheId()));
    return result;
  };

  return {
    uploadedSrtInfo,
    handleSrtUploadWithState,
    handleSrtClear: handleSrtClearWithState,
  };
};

export default useSrtUploadState;
