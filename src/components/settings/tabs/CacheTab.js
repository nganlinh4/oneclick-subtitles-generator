import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../../config';
import CloseButton from '../../common/CloseButton';

const CacheTab = ({ isActive }) => {
  const { t } = useTranslation();
  const [clearingCache, setClearingCache] = useState(false);
  const [loadingCacheInfo, setLoadingCacheInfo] = useState(false);
  const [cacheDetails, setCacheDetails] = useState(null);

  // Ref to track if we've shown the cache empty toast for the current active state
  const hasShownEmptyToastRef = useRef(false);

  // Function to fetch cache information
  const fetchCacheInfo = async (showToast = false) => {
    setLoadingCacheInfo(true);

    try {
      const response = await fetch(`${API_BASE_URL}/cache-info`);
      const data = await response.json();

      if (data.success) {
        setCacheDetails(data.details);

        // If cache is empty, show a message only if showToast is true and we haven't shown it yet
        if (data.details.totalCount === 0 && showToast && !hasShownEmptyToastRef.current) {
          window.addToast(t('settings.cacheEmpty', 'Cache is empty. No files to clear.'), 'info', 5000);
          hasShownEmptyToastRef.current = true;
        }
      } else {
        throw new Error(data.error || 'Failed to fetch cache information');
      }
    } catch (error) {
      console.error('Error fetching cache info:', error);
      if (showToast) {
        window.addToast(t('settings.cacheInfoError', 'Error fetching cache information: {{errorMessage}}', { errorMessage: error.message }), 'error', 8000);
      }
    } finally {
      setLoadingCacheInfo(false);
    }
  };

  // Handle clear cache
  const handleClearCache = async () => {
    // No confirmation prompt as requested
    setClearingCache(true);
    // Don't reset cacheDetails here to prevent UI flashing

    try {
      const response = await fetch(`${API_BASE_URL}/clear-cache`, {
        method: 'DELETE'
      });

      const data = await response.json();
      if (data.success) {
        // Clear localStorage video/subtitle related items
        localStorage.removeItem('current_video_url');
        localStorage.removeItem('current_file_url');
        localStorage.removeItem('current_file_cache_id');

        // Clear narration cache
        localStorage.removeItem('narration_cache');

        // Check if details exist in the response
        if (data.details) {
          // Store the cache details for display
          setCacheDetails(data.details);
          
          // Set success message with details
          const totalFiles = data.details.totalCount || 0;
          const totalSize = data.details.formattedTotalSize || '0 Bytes';
          window.addToast(t('settings.cacheClearedDetails', 'Cache cleared: {{totalFiles}} files ({{totalSize}})', { totalFiles, totalSize }), 'success', 6000);
        } else {
          // Fallback for when details are missing
          window.addToast(t('settings.cacheClearedSuccess', 'Cache cleared successfully!'), 'success', 5000);
    
          // Fetch updated cache info if details weren't returned
          // Use a separate function to avoid state flashing
          await fetchCacheInfoQuietly();
        }
      } else {
        throw new Error(data.error || 'Failed to clear cache');
      }
    } catch (error) {
      console.error('Error clearing cache:', error);
      window.addToast(t('settings.cacheClearError', 'Error clearing cache: {{errorMessage}}', { errorMessage: error.message }), 'error', 8000);
      
      // Fetch updated cache info even if there was an error
      // Use a separate function to avoid state flashing
      await fetchCacheInfoQuietly();
    } finally {
      setClearingCache(false);
    }
  };

  // Handle clear individual cache type
  const handleClearIndividualCache = async (cacheType, displayName) => {
    setClearingCache(true);

    try {
      const response = await fetch(`${API_BASE_URL}/clear-cache/${cacheType}`, {
        method: 'DELETE'
      });

      const data = await response.json();
      if (data.success) {
        // Clear localStorage for specific types if needed
        if (cacheType === 'videos' || cacheType === 'subtitles') {
          localStorage.removeItem('current_video_url');
          localStorage.removeItem('current_file_url');
          localStorage.removeItem('current_file_cache_id');
        }

        if (cacheType === 'narrationOutput' || cacheType === 'narrationReference') {
          localStorage.removeItem('narration_cache');
        }

        // Set success message
        const clearedData = data.details[Object.keys(data.details)[0]];
        const clearedFiles = clearedData?.count || 0;
        const clearedSize = clearedData?.formattedSize || '0 Bytes';

        window.addToast(t('settings.individualCacheCleared', '{{displayName}} cleared: {{count}} files ({{size}})', {
          displayName,
          count: clearedFiles,
          size: clearedSize
        }), 'success', 6000);
        
        // Refresh cache info to update the display
        console.log(`🔄 Refreshing cache info after successful clear`);
        await fetchCacheInfoQuietly();
        console.log(`✅ Individual cache clear completed successfully`);
      } else {
        console.error(`❌ Cache clear failed:`, data);
        throw new Error(data.error || `Failed to clear ${displayName}`);
      }
    } catch (error) {
      console.error(`❌ Error clearing ${cacheType} cache:`, error);
      window.addToast(t('settings.individualCacheClearError', 'Error clearing {{displayName}}: {{errorMessage}}', {
        displayName,
        errorMessage: error.message
      }), 'error', 8000);
    } finally {
      setClearingCache(false);
    }
  };

  // Fetch cache info without showing loading state (to prevent UI flashing)
  const fetchCacheInfoQuietly = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/cache-info`);
      const data = await response.json();

      if (data.success) {
        setCacheDetails(data.details);
      }
    } catch (error) {
      console.error('Error fetching cache info quietly:', error);
      // Don't update status message here to avoid overriding the clear cache status
    }
  };

  // Reset the toast flag when switching to cache tab
  useEffect(() => {
    if (isActive) {
      hasShownEmptyToastRef.current = false;
    }
  }, [isActive]);

  // Fetch cache information when component mounts or isActive changes
  useEffect(() => {
    fetchCacheInfo(isActive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  return (
    <div className="settings-section cache-section">
      {/* Header */}
      <div className="cache-content">
        <div className="cache-section-header">
        </div>
        <p className="cache-description">
          {t('settings.cacheDescription', 'Clear all cached files including subtitles, videos, uploaded files, generated content, narration audio, and temporary files to free up space.')}
        </p>
      </div>

      {/* Action buttons row */}
      <div className="cache-actions-row">

        <div className="cache-actions">
          <button
            className="clear-cache-btn"
            onClick={handleClearCache}
            disabled={clearingCache}
          >
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

      {/* Loading indicator - only show when not clearing cache */}
      {loadingCacheInfo && !clearingCache && (
        <div className="cache-loading">
          <p>{t('settings.loadingCache', 'Loading cache information...')}</p>
        </div>
      )}

      {/* Empty cache info when no details are shown */}
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

      {/* Cache details with 2-column grid - show during clearing to prevent flashing */}
      {cacheDetails && (!loadingCacheInfo || clearingCache) && (
        <div className={`cache-details ${clearingCache ? 'clearing' : ''}`}>
          <div className="cache-details-grid-header">
            <div className="cache-details-header">
              <h4>{t('settings.cacheInformation', 'Cache Information')}</h4>
            </div>

            <div className="cache-details-summary">
              <p className="cache-total">
                <strong>{t('settings.totalCache', 'Total Cache: {{count}} files ({{size}})', { count: cacheDetails.totalCount, size: cacheDetails.formattedTotalSize })}</strong>
              </p>
            </div>
          </div>

          <div className="cache-details-grid">
            {/* Column 1 */}
            <div className="cache-details-column">
              <div className={`cache-details-item ${(cacheDetails.videos?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.videos', 'Videos')}:</h4>
                  {(cacheDetails.videos?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => handleClearIndividualCache('videos', t('settings.videos', 'Videos'))}
                      disabled={clearingCache}
                      title={t('settings.clearVideos', 'Clear Videos')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.videosCount', '{{count}} files ({{size}})', { count: cacheDetails.videos?.count || 0, size: cacheDetails.videos?.formattedSize || '0 Bytes' })}
                </p>
              </div>

              <div className={`cache-details-item ${(cacheDetails.subtitles?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.subtitles', 'Subtitles')}:</h4>
                  {(cacheDetails.subtitles?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => handleClearIndividualCache('subtitles', t('settings.subtitles', 'Subtitles'))}
                      disabled={clearingCache}
                      title={t('settings.clearSubtitles', 'Clear Subtitles')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.subtitlesCount', '{{count}} files ({{size}})', { count: cacheDetails.subtitles?.count || 0, size: cacheDetails.subtitles?.formattedSize || '0 Bytes' })}
                </p>
              </div>

              <div className={`cache-details-item ${(cacheDetails.userSubtitles?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.userSubtitles', 'User Subtitles')}:</h4>
                  {(cacheDetails.userSubtitles?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => handleClearIndividualCache('userSubtitles', t('settings.userSubtitles', 'User Subtitles'))}
                      disabled={clearingCache}
                      title={t('settings.clearUserSubtitles', 'Clear User Subtitles')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.userSubtitlesCount', '{{count}} files ({{size}})', { count: cacheDetails.userSubtitles?.count || 0, size: cacheDetails.userSubtitles?.formattedSize || '0 Bytes' })}
                </p>
              </div>

              <div className={`cache-details-item ${(cacheDetails.rules?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.rules', 'Transcription Rules')}:</h4>
                  {(cacheDetails.rules?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => handleClearIndividualCache('rules', t('settings.rules', 'Transcription Rules'))}
                      disabled={clearingCache}
                      title={t('settings.clearRules', 'Clear Transcription Rules')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.rulesCount', '{{count}} files ({{size}})', { count: cacheDetails.rules?.count || 0, size: cacheDetails.rules?.formattedSize || '0 Bytes' })}
                </p>
              </div>
            </div>

            {/* Column 2 */}
            <div className="cache-details-column">
              <div className={`cache-details-item ${(cacheDetails.lyrics?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.lyrics', 'Lyrics')}:</h4>
                  {(cacheDetails.lyrics?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => handleClearIndividualCache('lyrics', t('settings.lyrics', 'Lyrics'))}
                      disabled={clearingCache}
                      title={t('settings.clearLyrics', 'Clear Lyrics')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.lyricsCount', '{{count}} files ({{size}})', { count: cacheDetails.lyrics?.count || 0, size: cacheDetails.lyrics?.formattedSize || '0 Bytes' })}
                </p>
              </div>

              <div className={`cache-details-item ${(cacheDetails.albumArt?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.albumArt', 'Album Art')}:</h4>
                  {(cacheDetails.albumArt?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => handleClearIndividualCache('albumArt', t('settings.albumArt', 'Album Art'))}
                      disabled={clearingCache}
                      title={t('settings.clearAlbumArt', 'Clear Album Art')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.albumArtCount', '{{count}} files ({{size}})', { count: cacheDetails.albumArt?.count || 0, size: cacheDetails.albumArt?.formattedSize || '0 Bytes' })}
                </p>
              </div>

              <div className={`cache-details-item ${(cacheDetails.uploads?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.uploads', 'Uploaded Files')}:</h4>
                  {(cacheDetails.uploads?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => handleClearIndividualCache('uploads', t('settings.uploads', 'Uploaded Files'))}
                      disabled={clearingCache}
                      title={t('settings.clearUploads', 'Clear Uploaded Files')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.uploadsCount', '{{count}} files ({{size}})', { count: cacheDetails.uploads?.count || 0, size: cacheDetails.uploads?.formattedSize || '0 Bytes' })}
                </p>
              </div>

              <div className={`cache-details-item ${(cacheDetails.output?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.output', 'Generated Videos')}:</h4>
                  {(cacheDetails.output?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => handleClearIndividualCache('output', t('settings.output', 'Generated Videos'))}
                      disabled={clearingCache}
                      title={t('settings.clearOutput', 'Clear Generated Videos')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.outputCount', '{{count}} files ({{size}})', { count: cacheDetails.output?.count || 0, size: cacheDetails.output?.formattedSize || '0 Bytes' })}
                </p>
              </div>
            </div>

            {/* Column 3 */}
            <div className="cache-details-column">
              <div className={`cache-details-item ${(cacheDetails.narrationReference?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.narrationReference', 'Narration Reference Audio')}:</h4>
                  {(cacheDetails.narrationReference?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => handleClearIndividualCache('narrationReference', t('settings.narrationReference', 'Narration Reference Audio'))}
                      disabled={clearingCache}
                      title={t('settings.clearNarrationReference', 'Clear Narration Reference Audio')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.narrationReferenceCount', '{{count}} files ({{size}})', { count: cacheDetails.narrationReference?.count || 0, size: cacheDetails.narrationReference?.formattedSize || '0 Bytes' })}
                </p>
              </div>

              <div className={`cache-details-item ${(cacheDetails.narrationOutput?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.narrationOutput', 'Narration Output Audio')}:</h4>
                  {(cacheDetails.narrationOutput?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => {
                        console.log('🖱️ Narration Output cache clear button clicked');
                        handleClearIndividualCache('narrationOutput', t('settings.narrationOutput', 'Narration Output Audio'));
                      }}
                      disabled={clearingCache}
                      title={t('settings.clearNarrationOutput', 'Clear Narration Output Audio')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.narrationOutputCount', '{{count}} files ({{size}})', { count: cacheDetails.narrationOutput?.count || 0, size: cacheDetails.narrationOutput?.formattedSize || '0 Bytes' })}
                </p>
              </div>

              <div className={`cache-details-item ${(cacheDetails.videoRendered?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.videoRendered', 'Rendered Videos')}:</h4>
                  {(cacheDetails.videoRendered?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => handleClearIndividualCache('videoRendered', t('settings.videoRendered', 'Rendered Videos'))}
                      disabled={clearingCache}
                      title={t('settings.clearVideoRendered', 'Clear Rendered Videos')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.videoRenderedCount', '{{count}} files ({{size}})', { count: cacheDetails.videoRendered?.count || 0, size: cacheDetails.videoRendered?.formattedSize || '0 Bytes' })}
                </p>
              </div>

              <div className={`cache-details-item ${(cacheDetails.videoTemp?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.videoTemp', 'Temporary Videos')}:</h4>
                  {(cacheDetails.videoTemp?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => handleClearIndividualCache('videoTemp', t('settings.videoTemp', 'Temporary Videos'))}
                      disabled={clearingCache}
                      title={t('settings.clearVideoTemp', 'Clear Temporary Videos')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.videoTempCount', '{{count}} files ({{size}})', { count: cacheDetails.videoTemp?.count || 0, size: cacheDetails.videoTemp?.formattedSize || '0 Bytes' })}
                </p>
              </div>
            </div>

            {/* Column 4 */}
            <div className="cache-details-column">
              <div className={`cache-details-item ${(cacheDetails.videoAlbumArt?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.videoAlbumArt', 'Video Album Art')}:</h4>
                  {(cacheDetails.videoAlbumArt?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => handleClearIndividualCache('videoAlbumArt', t('settings.videoAlbumArt', 'Video Album Art'))}
                      disabled={clearingCache}
                      title={t('settings.clearVideoAlbumArt', 'Clear Video Album Art')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.videoAlbumArtCount', '{{count}} files ({{size}})', { count: cacheDetails.videoAlbumArt?.count || 0, size: cacheDetails.videoAlbumArt?.formattedSize || '0 Bytes' })}
                </p>
              </div>

              <div className={`cache-details-item ${(cacheDetails.videoRendererUploads?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.videoRendererUploads', 'Video Renderer Uploads')}:</h4>
                  {(cacheDetails.videoRendererUploads?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => handleClearIndividualCache('videoRendererUploads', t('settings.videoRendererUploads', 'Video Renderer Uploads'))}
                      disabled={clearingCache}
                      title={t('settings.clearVideoRendererUploads', 'Clear Video Renderer Uploads')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.videoRendererUploadsCount', '{{count}} files ({{size}})', { count: cacheDetails.videoRendererUploads?.count || 0, size: cacheDetails.videoRendererUploads?.formattedSize || '0 Bytes' })}
                </p>
              </div>

              <div className={`cache-details-item ${(cacheDetails.videoRendererOutput?.count || 0) === 0 ? 'empty-cache-item' : ''}`}>
                <div className="cache-item-header">
                  <h4>{t('settings.videoRendererOutput', 'Video Renderer Output')}:</h4>
                  {(cacheDetails.videoRendererOutput?.count || 0) > 0 && (
                    <button
                      type="button"
                      className="remove-key"
                      onClick={() => handleClearIndividualCache('videoRendererOutput', t('settings.videoRendererOutput', 'Video Renderer Output'))}
                      disabled={clearingCache}
                      title={t('settings.clearVideoRendererOutput', 'Clear Video Renderer Output')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                    </button>
                  )}
                </div>
                <p>
                  {t('settings.videoRendererOutputCount', '{{count}} files ({{size}})', { count: cacheDetails.videoRendererOutput?.count || 0, size: cacheDetails.videoRendererOutput?.formattedSize || '0 Bytes' })}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CacheTab;
