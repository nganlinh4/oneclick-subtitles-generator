import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import CloseButton from './common/CloseButton';
import '../styles/VideoQualityModal.css';
// import progressWebSocketClient from '../utils/progressWebSocketClient'; // DISABLED - using polling instead
import LoadingIndicator from './common/LoadingIndicator';
import WavyProgressIndicator from './common/WavyProgressIndicator';

const VideoQualityModal = ({
  isOpen,
  onClose,
  onConfirm,
  videoInfo,
  actualDimensions,
  availableVersions = []
}) => {
  const { t } = useTranslation();
  const [selectedOption, setSelectedOption] = useState('current');
  const [selectedVersion, setSelectedVersion] = useState(null);
  const [selectedQuality, setSelectedQuality] = useState(null);
  const [isRedownloading, setIsRedownloading] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [availableQualities, setAvailableQualities] = useState([]);
  const [qualityVideoId, setQualityVideoId] = useState(null);

  const [downloadProgress, setDownloadProgress] = useState(0);
  const progressIntervalRef = useRef(null);

  // Get current cookie setting as state
  const [useCookiesEnabled, setUseCookiesEnabled] = useState(
    localStorage.getItem('use_cookies_for_download') === 'true'
  );

  // Ref for WavyProgressIndicator animations
  const wavyProgressRef = useRef(null);

  // Robust theme detection: look at <html>, <body>, and 'dark' class
  const detectDarkTheme = () => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    try {
      const root = document.documentElement;
      const body = document.body;
      const attr = (root.getAttribute('data-theme') || body?.getAttribute('data-theme') || '').toLowerCase();
      if (attr === 'dark') return true;
      if (root.classList.contains('dark') || body?.classList.contains('dark')) return true;
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return true;
      // Fallback: infer from --md-surface luminance
      const surface = getComputedStyle(root).getPropertyValue('--md-surface').trim();
      const c = surface.startsWith('#') ? surface.slice(1) : surface;
      if (c && (c.length === 6 || c.length === 3)) {
        const hex = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
        const r = parseInt(hex.slice(0,2),16)/255;
        const g = parseInt(hex.slice(2,4),16)/255;
        const b = parseInt(hex.slice(4,6),16)/255;
        const toLin = (u) => (u <= 0.03928 ? u/12.92 : Math.pow((u+0.055)/1.055, 2.4));
        const L = 0.2126*toLin(r) + 0.7152*toLin(g) + 0.0722*toLin(b);
        if (L < 0.5) return true; // dark surface
      }
    } catch {}
    return false;
  };
  const isDarkTheme = detectDarkTheme();

  // Helpers to read CSS variables
  const getCssVar = (name, fallback) => {
    if (typeof window === 'undefined') return fallback;
    const styles = getComputedStyle(document.documentElement);
    const val = styles.getPropertyValue(name).trim();
    return val || fallback;
  };

  // Colors for spinner and wavy progress (invert variants per theme)
  const waveColor = isDarkTheme ? '#FFFFFF' : getCssVar('--md-primary', '#5D5FEF');
  const waveTrackColor = isDarkTheme ? 'rgba(255,255,255,0.35)' : '#404659';




  // Handle entrance/disappear animations for WavyProgressIndicator
  useEffect(() => {
    if (isRedownloading && wavyProgressRef.current) {
      wavyProgressRef.current.startEntranceAnimation();
    } else if (!isRedownloading && wavyProgressRef.current) {
      wavyProgressRef.current.startDisappearanceAnimation();
    }
  }, [isRedownloading]);

  // Wrapper function for onClose to ensure cleanup
  const handleClose = () => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    onClose();
  };

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {

      setSelectedOption('current');
      setSelectedVersion(null);
      setSelectedQuality(null);
      setIsRedownloading(false);
      setIsScanning(false);
      setAvailableQualities([]);
      setDownloadProgress(0);

      // Clear any existing progress interval
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }

      // Don't scan qualities automatically - only when redownload is selected
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, videoInfo]);

  // Scan qualities when redownload option is selected
  useEffect(() => {
    if (selectedOption === 'redownload' && videoInfo && videoInfo.url &&
        ['youtube', 'douyin', 'all-sites'].includes(videoInfo.source) &&
        availableQualities.length === 0 && !isScanning) {
      scanVideoQualities();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOption, videoInfo]);

  // Set default version selection for uploaded videos
  useEffect(() => {
    if (availableVersions.length > 0 && !selectedVersion) {
      // Default to original version if available
      const originalVersion = availableVersions.find(v => v.type === 'original');
      setSelectedVersion(originalVersion || availableVersions[0]);
    }
  }, [availableVersions, selectedVersion]);

  // Scan available video qualities using the new polling system
  const scanVideoQualities = async () => {
    if (!videoInfo || !videoInfo.url) return;

    setIsScanning(true);
    try {
      // Import the polling-based quality scanner
      const { scanVideoQualities: scanQualities } = await import('../utils/qualityScanner');
      const qualities = await scanQualities(videoInfo.url);

      setAvailableQualities(qualities);
      // Default to highest quality
      if (qualities.length > 0) {
        setSelectedQuality(qualities[0]);
      }
    } catch (error) {
      console.error('Error scanning qualities:', error);
      setAvailableQualities([]);
    } finally {
      setIsScanning(false);
    }
  };


  // Cancel an in-progress quality re-download
  const handleCancelRedownload = async () => {
    try {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
      if (qualityVideoId) {
        await fetch(`http://localhost:3031/api/cancel-quality-download/${encodeURIComponent(qualityVideoId)}`, { method: 'POST' });
      }
    } catch (e) {
      // ignore
    } finally {
      setIsRedownloading(false);
    }
  };


  // Start quality download with pre-generated video ID
  const startQualityDownloadWithId = async (quality, url, videoId) => {
    const response = await fetch('http://localhost:3031/api/download-video-quality', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: url,
        quality: quality,
        videoId: videoId,
        useCookies: localStorage.getItem('use_cookies_for_download') === 'true'
      }),
    });

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to start download');
    }

    return data;
  };

  // Start progress tracking using polling (WebSocket disabled to prevent duplicates)
  const startProgressTracking = (videoId, quality, url) => {
    // Clear any existing interval first
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }

    // Use polling instead of WebSocket
    const newProgressInterval = setInterval(async () => {
      try {
        const response = await fetch(`http://localhost:3031/api/quality-download-progress/${videoId}`);
        const data = await response.json();

        if (data.success) {
          const newProgress = data.progress || 0;

          // Filter out unreasonable progress values
          if (newProgress >= 0 && newProgress <= 100) {
            setDownloadProgress(newProgress);
          }

          if (data.status === 'completed') {
            clearInterval(newProgressInterval);
            progressIntervalRef.current = null;
            setIsRedownloading(false);
            setDownloadProgress(100);

            // Call onConfirm to proceed to rendering, then close modal
            setTimeout(async () => {
              try {
                await onConfirm('redownload', {
                  quality: quality,
                  url: url,
                  videoId: videoId
                });
                handleClose();
              } catch (error) {
                console.error('[VideoQualityModal] Error confirming redownload:', error);
                handleClose();
              }
            }, 1000);
          } else if (data.status === 'cancelled') {
            clearInterval(newProgressInterval);
            progressIntervalRef.current = null;
            setIsRedownloading(false);
          } else if (data.status === 'error') {
            clearInterval(newProgressInterval);
            progressIntervalRef.current = null;
            setIsRedownloading(false);
            console.error('[VideoQualityModal] Download error:', data.error);
          }
        }
      } catch (error) {
        console.error('Error fetching download progress:', error);
      }
    }, 1000);

    // Store interval in ref for cleanup
    progressIntervalRef.current = newProgressInterval;
  };



  // Cleanup progress tracking on unmount or when modal closes
  React.useEffect(() => {
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    };
  }, []);

  // Listen for changes to cookie setting and update when modal opens
  useEffect(() => {
    if (isOpen) {
      // Update cookie setting when modal opens
      setUseCookiesEnabled(localStorage.getItem('use_cookies_for_download') === 'true');
    }

    const handleStorageChange = () => {
      setUseCookiesEnabled(localStorage.getItem('use_cookies_for_download') === 'true');
    };

    const handleFocus = () => {
      // Update when window regains focus (e.g., after closing settings modal)
      setUseCookiesEnabled(localStorage.getItem('use_cookies_for_download') === 'true');
    };

    // Listen for storage events (when localStorage changes in other tabs/windows)
    window.addEventListener('storage', handleStorageChange);
    // Listen for focus events (when user returns to tab/window)
    window.addEventListener('focus', handleFocus);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleConfirm = async () => {
    if (selectedOption === 'redownload') {
      if (!selectedQuality) {
        alert('Please select a quality to download');
        return;
      }

      setIsRedownloading(true);
      setDownloadProgress(0);

      try {
        // Generate video ID first
        const videoId = `quality_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        // Save the quality videoId so cancel button can use it
        setQualityVideoId(videoId);

        // Start progress tracking BEFORE starting download
        startProgressTracking(videoId, selectedQuality.quality, videoInfo.url);

        // Start the download with the pre-generated video ID
        await startQualityDownloadWithId(selectedQuality.quality, videoInfo.url, videoId);

        // Progress tracking will handle completion and proceed to rendering automatically
      } catch (error) {
        console.error('Error redownloading video:', error);
        setIsRedownloading(false);
        setDownloadProgress(0);

        // WebSocket cleanup removed - using polling instead

        // Clear progress interval on error
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current);
          progressIntervalRef.current = null;
        }
        return;
      }
    } else if (selectedOption === 'version' && selectedVersion) {
      await onConfirm('version', { version: selectedVersion });
      handleClose();
    } else {
      await onConfirm('current');
      handleClose();
    }
  };

  const getVideoSourceDisplay = () => {
    if (!videoInfo) return t('videoQuality.unknownSource', 'Unknown source');

    switch (videoInfo.source) {
      case 'youtube':
        return t('videoQuality.youtubeVideo', 'YouTube Video');
      case 'douyin':
        return t('videoQuality.douyinVideo', 'Douyin Video');
      case 'douyin':
        return t('videoQuality.douyinVideo', 'Douyin Video');
      case 'all-sites':
        return t('videoQuality.webVideo', 'Web Video');
      case 'upload':
        return t('videoQuality.uploadedVideo', 'Uploaded Video');
      default:
        return t('videoQuality.unknownSource', 'Unknown source');
    }
  };

  const getCurrentQuality = () => {
    if (!videoInfo) return t('videoQuality.unknownQuality', 'Unknown quality');

    if (videoInfo.source === 'upload') {
      const quality = videoInfo.quality || '360p';
      const qualityWithDimensions = actualDimensions?.dimensions 
        ? `${quality} (${actualDimensions.dimensions})`
        : quality;
      
      return videoInfo.isOptimized
        ? t('videoQuality.optimizedQuality', 'Optimized ({{quality}})', { quality: qualityWithDimensions })
        : t('videoQuality.originalQuality', 'Original Quality');
    }

    // Show actual dimensions if available
    const baseQuality = videoInfo.quality || '360p';
    if (actualDimensions?.dimensions) {
      return `${baseQuality} (${actualDimensions.dimensions})`;
    }

    // Show quality as-is if it already includes dimensions
    if (videoInfo.quality && videoInfo.quality.includes('×')) {
      return videoInfo.quality;
    }

    return baseQuality;
  };

  const showRedownloadOption = videoInfo?.source &&
    ['youtube', 'all-sites'].includes(videoInfo.source) &&
    videoInfo.url; // Only show if we have a URL to redownload from (excluding Douyin)

  const showVersionOption = availableVersions.length > 0;

  return (
    <div className="video-quality-modal-overlay" onClick={handleClose}>
      <div className="video-quality-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="header-content">
            <h3>{t('videoQuality.title', 'Video Quality for Rendering')}</h3>
            <div className={`header-badge ${useCookiesEnabled ? 'cookie-enabled' : 'cookie-disabled'}`}
                 title={useCookiesEnabled
                   ? t('videoQuality.cookieSupportTooltip', 'Uses browser cookies for authentication to access higher quality videos and bypass login restrictions')
                   : t('videoQuality.cookieDisabledTooltip', 'Browser cookies are disabled. Downloads will be faster but may have limited quality options and fail on restricted content.')
                 }>
              <span className="material-symbols-rounded badge-icon">info</span>
              <span className="badge-text">
                {useCookiesEnabled
                  ? t('videoQuality.cookieSupport', 'Browser Cookie Added')
                  : t('videoQuality.cookieDisabled', 'Browser Cookie Disabled')
                }
              </span>
            </div>
          </div>
          <CloseButton onClick={handleClose} variant="modal" size="medium" />
        </div>

        <div className="modal-content">
          <div className="video-info">
            <div className="info-row">
              <span className="label">{t('videoQuality.source', 'Source')}:</span>
              <span className="value">{getVideoSourceDisplay()}</span>
            </div>
            <div className="info-row">
              <span className="label">{t('videoQuality.currentQuality', 'Current Quality')}:</span>
              <span className="value">{getCurrentQuality()}</span>
            </div>
            {videoInfo?.title && (
              <div className="info-row">
                <span className="label">{t('videoQuality.title', 'Title')}:</span>
                <span className="value" title={videoInfo.title}>
                  {videoInfo.title.length > 50
                    ? `${videoInfo.title.substring(0, 50)}...`
                    : videoInfo.title}
                </span>
              </div>
            )}
          </div>

          <div className="quality-options" style={{ paddingTop: '20px' }}>
            <h4>{t('videoQuality.chooseOption', 'Choose an option for rendering:')}</h4>

            {/* Current quality option */}
            <label className="option-item">
              <input
                type="radio"
                name="quality-option"
                value="current"
                checked={selectedOption === 'current'}
                onChange={(e) => setSelectedOption(e.target.value)}
              />
              <div className="option-content">
                <div className="option-title">
                  {t('videoQuality.useCurrent', 'Use current video quality')}
                </div>
                <div className="option-description">
                  {t('videoQuality.useCurrentDesc', 'Render with the video currently playing in the preview ({{quality}})',
                    { quality: getCurrentQuality() })}
                </div>
              </div>
            </label>

            {/* Redownload option for online videos */}
            {showRedownloadOption && (
              <label className="option-item">
                <input
                  type="radio"
                  name="quality-option"
                  value="redownload"
                  checked={selectedOption === 'redownload'}
                  onChange={(e) => setSelectedOption(e.target.value)}
                />
                <div className="option-content">
                  <div className="option-title">
                    {t('videoQuality.redownloadQuality', 'Redownload in different quality')}
                  </div>
                  <div className="option-description">
                    {t('videoQuality.redownloadQualityDesc', 'Download the video again in a different quality for rendering')}
                  </div>

                  {selectedOption === 'redownload' && (
                    <div className="quality-selector">
                      {isScanning ? (
                        <div className="scanning-indicator">
                          {t('videoQuality.scanningQualities', 'Scanning available qualities...')}
                        </div>
                      ) : availableQualities.length > 0 ? (
                        <div className="quality-options-list">
                          <div className="quality-selector-title">
                            {t('videoQuality.selectQuality', 'Select quality:')}
                          </div>
                          {availableQualities.map((quality, index) => (
                            <div key={index} className="radio-pill">
                              <input
                                type="radio"
                                id={`quality-${index}`}
                                name="quality"
                                checked={selectedQuality?.quality === quality.quality}
                                onChange={() => setSelectedQuality(quality)}
                              />
                              <label htmlFor={`quality-${index}`} className="quality-pill-label">
                                {quality.label || quality.description || quality.quality}
                              </label>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="no-qualities">
                          {t('videoQuality.noQualitiesFound', 'No additional qualities found')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </label>
            )}

            {/* Version selection for uploaded videos */}
            {showVersionOption && (
              <label className="option-item">
                <input
                  type="radio"
                  name="quality-option"
                  value="version"
                  checked={selectedOption === 'version'}
                  onChange={(e) => setSelectedOption(e.target.value)}
                />
                <div className="option-content">
                  <div className="option-title">
                    {t('videoQuality.selectVersion', 'Select video version')}
                  </div>
                  <div className="option-description">
                    {t('videoQuality.selectVersionDesc', 'Choose from available video versions')}
                  </div>

                  {selectedOption === 'version' && (
                    <div className="version-selector">
                      {availableVersions.map((version, index) => (
                        <div key={index} className="radio-pill">
                          <input
                            type="radio"
                            id={`version-${index}`}
                            name="version"
                            checked={selectedVersion?.path === version.path}
                            onChange={() => setSelectedVersion(version)}
                          />
                          <label htmlFor={`version-${index}`} className="version-pill-label">
                            <div className="version-title">
                              {version.type === 'original'
                                ? t('videoQuality.originalVersion', 'Original Quality')
                                : t('videoQuality.optimizedVersion', 'Optimized ({{quality}})', { quality: version.quality || '360p' })}
                            </div>
                            {version.resolution && (
                              <div className="version-details">
                                {version.resolution} • {version.fps || 30}fps
                              </div>
                            )}
                          </label>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </label>
            )}
          </div>
        </div>

        <div className="modal-actions">
          {isRedownloading ? (
            <button
              className="cancel-button"
              onClick={handleCancelRedownload}
            >
              {t('download.downloadOnly.cancelDownload', 'Cancel Download')}
            </button>
          ) : (
            <button
              className="cancel-button"
              onClick={handleClose}
            >
              {t('common.cancel', 'Cancel')}
            </button>
          )}
          <button
            className="confirm-button"
            onClick={handleConfirm}
            disabled={
              isRedownloading ||
              isScanning ||
              (selectedOption === 'version' && !selectedVersion) ||
              (selectedOption === 'redownload' && !selectedQuality)
            }
          >
            {isRedownloading ? (
              <span className="processing-text-container">
                <LoadingIndicator
                  theme={isDarkTheme ? 'light' : 'dark'}
                  showContainer={false}
                  size={16}
                  className="buttons-processing-loading"
                  color={waveColor}
                />
                <div
                  className="processing-wavy"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    '--wavy-progress-color': waveColor,
                    '--figma-progress-color': waveColor,
                    '--figma-track-color': waveTrackColor
                  }}
                >
                  <WavyProgressIndicator
                    ref={wavyProgressRef}
                    progress={Math.max(0, Math.min(1, (downloadProgress || 0) / 100))}
                    animate={true}
                    showStopIndicator={true}
                    waveSpeed={1.2}
                    width={140}
                    autoAnimateEntrance={false}
                    color={waveColor}
                    trackColor={waveTrackColor}
                    stopIndicatorColor={waveColor}
                  />
                  <span className="processing-text" style={{ flexShrink: 0, whiteSpace: 'nowrap', marginLeft: '8px' }}>
                    {t('videoQuality.redownloading', 'Redownloading...')}
                  </span>
                </div>
              </span>
            ) : isScanning ? (
              t('videoQuality.scanning', 'Scanning...')
            ) : (
              t('common.confirm', 'Confirm')
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default VideoQualityModal;
