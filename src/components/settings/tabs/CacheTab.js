import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clearCache, getCacheInfo } from '../../../platform/cacheService';

const SUMMARY_KEYS = new Set(['totalCount', 'totalSize', 'formattedTotalSize']);

// These labels describe category identifiers already written by supported OSG versions. The list is
// presentation-only: it does not invent empty categories or restrict newer identifiers returned by
// Rust. Unknown native categories are displayed with a readable label and remain clearable.
const CATEGORY_LABELS = Object.freeze({
  albumArt: ['settings.albumArt', 'Cached Album Art'],
  alignedNarration: ['settings.alignedNarration', 'Cached Aligned Narration'],
  downloadedMedia: ['settings.videos', 'Cached Video Data'],
  generatedBackgroundImage: ['settings.generatedBackgroundImages', 'Cached Generated Background Images'],
  lyrics: ['settings.lyrics', 'Cached Lyrics'],
  narrationOutput: ['settings.narrationOutput', 'Cached Narration Output Audio'],
  narrationReference: ['settings.narrationReference', 'Cached Narration Reference Audio'],
  output: ['settings.output', 'Cached Generated Video Data'],
  renderedVideo: ['settings.videoRendered', 'Cached Render Data'],
  rules: ['settings.rules', 'Cached Transcription Rules'],
  subtitles: ['settings.subtitles', 'Cached Subtitle Data'],
  uploads: ['settings.uploads', 'Temporary Upload Copies'],
  userSubtitles: ['settings.userSubtitles', 'Cached Imported Subtitle Data'],
  videoAlbumArt: ['settings.videoAlbumArt', 'Cached Video Album Art'],
  videoRendered: ['settings.videoRendered', 'Cached Render Data'],
  videos: ['settings.videos', 'Cached Video Data'],
  videoTemp: ['settings.videoTemp', 'Temporary Video Data'],
  voiceConversion: ['settings.voiceConversion', 'Cached Voice Conversion Data'],
  waveform: ['settings.waveform', 'Cached Waveforms'],
});

const readableCategory = (category) => category
  .replace(/[._:-]+/g, ' ')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/^./, (letter) => letter.toUpperCase());

const categoryLabel = (t, category) => {
  const known = CATEGORY_LABELS[category];
  return known ? t(known[0], known[1]) : readableCategory(category);
};

const categoryEntries = (details) => Object.entries(details ?? {}).filter(([key, value]) => (
  !SUMMARY_KEYS.has(key)
  && value !== null
  && typeof value === 'object'
  && Number.isSafeInteger(value.count)
  && value.count >= 0
  && Number.isSafeInteger(value.size)
  && value.size >= 0
));

const CacheTab = ({ isActive }) => {
  const { t } = useTranslation();
  const translationRef = useRef(t);
  translationRef.current = t;
  const [clearingCache, setClearingCache] = useState(false);
  const [loadingCacheInfo, setLoadingCacheInfo] = useState(false);
  const [cacheDetails, setCacheDetails] = useState(null);
  const hasShownEmptyToastRef = useRef(false);

  const fetchCacheInfoQuietly = useCallback(async () => {
    try {
      const data = await getCacheInfo();
      if (data.success) setCacheDetails(data.details);
    } catch (error) {
      console.error('Error fetching cache info quietly:', error);
    }
  }, []);

  const fetchCacheInfo = useCallback(async (showToast = false) => {
    setLoadingCacheInfo(true);
    try {
      const data = await getCacheInfo();
      if (!data.success) throw new Error(data.error || 'Failed to fetch cache information');
      setCacheDetails(data.details);
      if (data.details.totalCount === 0 && showToast && !hasShownEmptyToastRef.current) {
        window.addToast(
          translationRef.current('settings.cacheEmpty', 'Cache is empty. No files to clear.'),
          'info',
          5000
        );
        hasShownEmptyToastRef.current = true;
      }
    } catch (error) {
      console.error('Error fetching cache info:', error);
      if (showToast) {
        window.addToast(
          translationRef.current('settings.cacheInfoError', 'Error fetching cache information: {{errorMessage}}', {
            errorMessage: error.message,
          }),
          'error',
          8000
        );
      }
    } finally {
      setLoadingCacheInfo(false);
    }
  }, []);

  const handleClearCache = async () => {
    setClearingCache(true);
    try {
      const data = await clearCache();
      if (!data.success) throw new Error(data.error || 'Failed to clear cache');

      const totalFiles = data.details?.totalCount ?? 0;
      const totalSize = data.details?.formattedTotalSize ?? '0 Bytes';
      window.addToast(
        t('settings.cacheClearedDetails', 'Cache cleared: {{totalFiles}} files ({{totalSize}})', {
          totalFiles,
          totalSize,
        }),
        'success',
        6000
      );

      // cache_clear returns what was removed. The grid represents what exists now, so read the
      // authoritative post-clear Rust snapshot instead of displaying removal deltas as live cache.
      await fetchCacheInfoQuietly();
    } catch (error) {
      console.error('Error clearing cache:', error);
      window.addToast(
        t('settings.cacheClearError', 'Error clearing cache: {{errorMessage}}', {
          errorMessage: error.message,
        }),
        'error',
        8000
      );
      await fetchCacheInfoQuietly();
    } finally {
      setClearingCache(false);
    }
  };

  const handleClearIndividualCache = async (cacheType, displayName) => {
    setClearingCache(true);
    try {
      const data = await clearCache(cacheType);
      if (!data.success) throw new Error(data.error || `Failed to clear ${displayName}`);

      const clearedData = data.details?.[cacheType];
      window.addToast(
        t(
          'settings.individualCacheCleared',
          '{{displayName}} cleared: {{count}} files ({{size}})',
          {
            displayName,
            count: clearedData?.count ?? 0,
            size: clearedData?.formattedSize ?? '0 Bytes',
          }
        ),
        'success',
        6000
      );
      await fetchCacheInfoQuietly();
    } catch (error) {
      console.error(`Error clearing ${cacheType} cache:`, error);
      window.addToast(
        t('settings.individualCacheClearError', 'Error clearing {{displayName}}: {{errorMessage}}', {
          displayName,
          errorMessage: error.message,
        }),
        'error',
        8000
      );
    } finally {
      setClearingCache(false);
    }
  };

  useEffect(() => {
    if (isActive) hasShownEmptyToastRef.current = false;
  }, [isActive]);

  useEffect(() => {
    // Entering a settings tab is not a request for a toast. The explicit Refresh action owns it.
    fetchCacheInfo(false);
  }, [fetchCacheInfo, isActive]);

  const displayedCategories = useMemo(() => categoryEntries(cacheDetails), [cacheDetails]);

  return (
    <div
      className="settings-section cache-section"
      data-cache-state={clearingCache
        ? 'clearing'
        : loadingCacheInfo
          ? 'checking'
          : cacheDetails === null ? 'failed' : 'ready'}
    >
      <div className="cache-content">
        <div className="cache-section-header" />
        <p className="cache-description">
          {t(
            'settings.cacheDescription',
            'Clear only rebuildable temporary data. Projects, imported source files, downloaded project media, exports, and installed tools or models are never deleted here.'
          )}
        </p>
      </div>

      <div className="cache-actions-row">
        <div className="cache-actions">
          <button className="clear-cache-btn" onClick={handleClearCache} disabled={clearingCache}>
            {clearingCache
              ? t('settings.clearingCache', 'Clearing Cache...')
              : t('settings.clearCache', 'Clear Cache')}
          </button>
          <button
            className="refresh-cache-btn"
            onClick={() => fetchCacheInfo(true)}
            disabled={loadingCacheInfo}
            title={t('settings.refreshCacheTooltip', 'Refresh cache information')}
          >
            <span className="material-symbols-rounded refresh-icon">refresh</span>
            {t('settings.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      {loadingCacheInfo && !clearingCache && (
        <div className="cache-loading">
          <p>{t('settings.loadingCache', 'Loading cache information...')}</p>
        </div>
      )}

      {!cacheDetails && !loadingCacheInfo && !clearingCache && (
        <div className="empty-cache-info">
          <p>{t('settings.cacheEmpty', 'No cache information available.')}</p>
          <button
            className="refresh-cache-btn"
            onClick={() => fetchCacheInfo(true)}
            disabled={loadingCacheInfo}
          >
            {t('settings.refreshCache', 'Refresh Cache Info')}
          </button>
        </div>
      )}

      {cacheDetails && (!loadingCacheInfo || clearingCache) && (
        <div className={`cache-details ${clearingCache ? 'clearing' : ''}`}>
          <div className="cache-details-grid-header">
            <div className="cache-details-header">
              <h4>{t('settings.cacheInformation', 'Cache Information')}</h4>
            </div>
            <div className="cache-details-summary">
              <p className="cache-total">
                <strong>
                  {t('settings.totalCache', 'Total Cache: {{count}} files ({{size}})', {
                    count: cacheDetails.totalCount,
                    size: cacheDetails.formattedTotalSize,
                  })}
                </strong>
              </p>
            </div>
          </div>

          {displayedCategories.length > 0 && (
            <div className="cache-details-grid">
              {displayedCategories.map(([category, details]) => {
                const displayName = categoryLabel(t, category);
                return (
                  <div
                    className={`cache-details-item ${details.count === 0 ? 'empty-cache-item' : ''}`}
                    data-cache-category={category}
                    key={category}
                  >
                    <div className="cache-item-header">
                      <h4>{displayName}:</h4>
                      {details.count > 0 && (
                        <button
                          type="button"
                          className="remove-key"
                          onClick={() => handleClearIndividualCache(category, displayName)}
                          disabled={clearingCache}
                          title={t('settings.clearCacheCategory', 'Clear {{category}}', {
                            category: displayName,
                          })}
                        >
                          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                        </button>
                      )}
                    </div>
                    <p>
                      {t('settings.cacheCategoryCount', '{{count}} files ({{size}})', {
                        count: details.count,
                        size: details.formattedSize,
                      })}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CacheTab;
