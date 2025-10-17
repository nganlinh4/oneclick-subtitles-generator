import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import CloseButton from './common/CloseButton';
import '../styles/DownloadOnlyModal.css';
import { scanVideoQualities } from '../utils/qualityScanner';

import { cancelDownloadOnly } from '../utils/downloadOnlyUtils';
import LoadingIndicator from './common/LoadingIndicator';
import WavyProgressIndicator from './common/WavyProgressIndicator';

// Global singleton to prevent multiple download modals
let activeDownloadModal = null;

const DownloadOnlyModal = ({
  isOpen,
  onClose,
  videoInfo
}) => {
  const { t } = useTranslation();
  const [selectedType, setSelectedType] = useState(''); // 'video' or 'audio' - no preselection
  const [selectedQuality, setSelectedQuality] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const [availableQualities, setAvailableQualities] = useState([]);
  const [isDownloading, setIsDownloading] = useState(false);
  const pollingIntervalRef = useRef(null);

  const [downloadProgress, setDownloadProgress] = useState(0);
  // eslint-disable-next-line no-unused-vars
  const [downloadVideoId, setDownloadVideoId] = useState(null);

  // Get current cookie setting as state
  const [useCookiesEnabled, setUseCookiesEnabled] = useState(
    localStorage.getItem('use_cookies_for_download') === 'true'
  );

  // Ref for WavyProgressIndicator animations
  const wavyProgressRef = useRef(null);

  // Robust theme detection: check data-theme and 'dark' class on html/body
  const detectDarkTheme = () => {
    if (typeof document === 'undefined') return false;
    const root = document.documentElement;
    const body = document.body;
    const attr = (root.getAttribute('data-theme') || body?.getAttribute('data-theme') || '').toLowerCase();
    if (attr === 'dark') return true;
    if (root.classList.contains('dark') || body?.classList.contains('dark')) return true;
    return false;
  };
  const isDarkTheme = detectDarkTheme();

  // Get CSS variable from :root
  const getCssVar = (name, fallback) => {
    if (typeof window === 'undefined') return fallback;
    const styles = getComputedStyle(document.documentElement);
    const val = styles.getPropertyValue(name).trim();
    return val || fallback;
  };
  const hexToRgba = (hex, alpha = 1) => {
    if (!hex) return `rgba(255,255,255,${alpha})`;
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  // Colors for spinner and wavy progress (invert variants per theme)
  const waveColor = isDarkTheme ? '#FFFFFF' : getCssVar('--md-primary', '#5D5FEF');
  const waveTrackColor = isDarkTheme ? 'rgba(255,255,255,0.35)' : hexToRgba(waveColor, 0.35);

  // Handle entrance/disappear animations for WavyProgressIndicator
  useEffect(() => {
    if (isDownloading && wavyProgressRef.current) {
      wavyProgressRef.current.startEntranceAnimation();
    } else if (!isDownloading && wavyProgressRef.current) {
      wavyProgressRef.current.startDisappearanceAnimation();
    }
  }, [isDownloading]);

  // Prevent multiple modal instances
  useEffect(() => {
    if (isOpen) {
      if (activeDownloadModal && activeDownloadModal !== onClose) {
        console.log('[DownloadOnlyModal] Another modal is already active, closing this one');
        onClose();
        return;
      }
      activeDownloadModal = onClose;
      console.log('[DownloadOnlyModal] Registered as active modal');
    }

    return () => {
      if (activeDownloadModal === onClose) {
        activeDownloadModal = null;
        console.log('[DownloadOnlyModal] Unregistered active modal');
      }
    };
  }, [isOpen, onClose]);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setSelectedType(''); // Don't preselect any type
      setSelectedQuality(null);
      setAvailableQualities([]);
      setIsScanning(false);
      setIsDownloading(false);
      setDownloadProgress(0);
      setDownloadVideoId(null);
    }
  }, [isOpen]);

  // Scan qualities when video type is selected (only when user actively selects video)
  useEffect(() => {
    if (selectedType === 'video' && videoInfo?.url && availableQualities.length === 0 && !isScanning) {
      handleScanQualities();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedType, videoInfo?.url]);

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

  const handleScanQualities = async () => {
    if (!videoInfo?.url) return;

    setIsScanning(true);
    try {
      const qualities = await scanVideoQualities(videoInfo.url);
      setAvailableQualities(qualities);

      // Auto-select 360p if available, otherwise select the first quality
      const preferred360p = qualities.find(q => q.quality === '360p');
      if (preferred360p) {
        setSelectedQuality(preferred360p);
      } else if (qualities.length > 0) {
        setSelectedQuality(qualities[0]);
      }
    } catch (error) {
      console.error('Error scanning qualities:', error);
      setAvailableQualities([]);
    } finally {
      setIsScanning(false);
    }
  };

  const handleDownload = async () => {
    if (!videoInfo?.url) return;

    setIsDownloading(true);
    setDownloadProgress(0);

    try {
      const downloadData = {
        url: videoInfo.url,
        type: selectedType,
        quality: selectedType === 'video' ? selectedQuality?.quality : null,
        source: videoInfo.source,
        useCookies: localStorage.getItem('use_cookies_for_download') === 'true'
      };

      const response = await fetch('http://localhost:3031/api/download-only', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(downloadData),
      });

      const result = await response.json();

      if (result.success) {
        const videoId = result.videoId;
        setDownloadVideoId(videoId);

        // TEMPORARILY DISABLE WEBSOCKET - Use polling instead to prevent duplicates
        console.log('[DownloadOnlyModal] Using polling instead of WebSocket to prevent duplicates');
        pollDownloadProgress(videoId);
      } else {
        throw new Error(result.error || 'Download failed');
      }
    } catch (error) {
      console.error('Error starting download:', error);
      setIsDownloading(false);
    }
  };

  const pollDownloadProgress = (videoId) => {
    // Clear any existing polling before starting a new one
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }

    const interval = setInterval(async () => {
      try {
        const response = await fetch(`http://localhost:3031/api/download-only-progress/${videoId}`);
        const data = await response.json();

        if (data.success) {
          setDownloadProgress(data.progress || 0);

          if (['completed', 'error', 'cancelled'].includes(data.status)) {
            clearInterval(interval);
            pollingIntervalRef.current = null;
            setIsDownloading(false);

            if (data.status === 'completed') {
              // Add a short delay to prevent race conditions where the file isn't fully written yet
              setTimeout(() => {
                const downloadUrl = `http://localhost:3031/api/download-only-file/${videoId}`;
                const a = document.createElement('a');
                a.href = downloadUrl;
                // The server will determine the correct extension, so we can provide a generic name
                a.download = `download_${videoId}`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              }, 500); // 500ms delay
            }

            // Close modal on any terminal state
            onClose();
          }
        }
      } catch (error) {
        console.error('Error polling download progress:', error);
      }
    }, 1000);

    // Save interval ref so we can clear on cancel/unmount
    pollingIntervalRef.current = interval;
  };

  const handleClose = () => {
    if (!isDownloading) {
      // Clear any polling if present
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      onClose();
    }
  };

  const handleCancel = async () => {
    if (isDownloading && downloadVideoId) {
      console.log('[DownloadOnlyModal] Cancelling download:', downloadVideoId);

      // Clear polling interval immediately
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }

      // Cancel the download on the server
      const success = await cancelDownloadOnly(downloadVideoId);

      if (success) {
        // Reset states
        setIsDownloading(false);
        setDownloadProgress(0);
        setDownloadVideoId(null);

        // Close the modal
        onClose();
      }
    }
  };

  const canDownload = () => {
    if (!selectedType) return false; // No type selected
    if (selectedType === 'audio') return true;
    if (selectedType === 'video') return selectedQuality !== null;
    return false;
  };

  // Clear any interval when component unmounts
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, []);

  if (!isOpen) return null;

  // Create portal content to render at root level
  const modalContent = (
    <div className="download-only-modal-overlay" onClick={handleClose}>
      <div className="download-only-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <div className="header-content">
            <h3>{t('download.downloadOnly.title', 'Download Media')}</h3>
            <div className={`header-badge ${useCookiesEnabled ? 'cookie-enabled' : 'cookie-disabled'}`}
                 title={useCookiesEnabled
                   ? t('download.downloadOnly.cookieSupportTooltip', 'Uses browser cookies for authentication to access higher quality videos and bypass login restrictions')
                   : t('download.downloadOnly.cookieDisabledTooltip', 'Browser cookies are disabled. Downloads will be faster but may have limited quality options and fail on restricted content.')
                 }>
              <span className="material-symbols-rounded badge-icon">info</span>
              <span className="badge-text">
                {useCookiesEnabled
                  ? t('download.downloadOnly.cookieSupport', 'Browser Cookie Added')
                  : t('download.downloadOnly.cookieDisabled', 'Browser Cookie Disabled')
                }
              </span>
            </div>
          </div>
          <CloseButton
            onClick={handleClose}
            disabled={isDownloading}
            variant="modal"
            size="medium"
          />
        </div>

        {/* Content */}
        <div className="modal-content">
          {/* Download Type Selection */}
          <div className="download-options">
            {/* Type Options Row */}
            <div className="type-options-row">
              {/* Video Option */}
              <label className="option-item">
                <input
                  type="radio"
                  name="download-type"
                  value="video"
                  checked={selectedType === 'video'}
                  onChange={(e) => setSelectedType(e.target.value)}
                  disabled={isDownloading}
                />
                <div className="option-content">
                  <div className="option-title">
                    <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>video_file</span>
                    {t('download.downloadOnly.video', 'Video')}
                  </div>
                  <div className="option-description">
                    {t('download.downloadOnly.videoDesc', 'Download video with selected quality')}
                  </div>
                </div>
              </label>

              {/* Audio Option */}
              <label className="option-item">
                <input
                  type="radio"
                  name="download-type"
                  value="audio"
                  checked={selectedType === 'audio'}
                  onChange={(e) => setSelectedType(e.target.value)}
                  disabled={isDownloading}
                />
                <div className="option-content">
                  <div className="option-title">
                    <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>music_note</span>
                    {t('download.downloadOnly.audio', 'Audio')}
                  </div>
                  <div className="option-description">
                    {t('download.downloadOnly.audioDesc', 'Download audio only (MP3 format)')}
                  </div>
                </div>
              </label>
            </div>

            {/* Quality Selector for Video - Outside the grid */}
            {selectedType === 'video' && (
              <div className="quality-selector">
                {isScanning ? (
                  <div className="scanning-indicator">
                    {t('download.downloadOnly.scanningQualities', 'Scanning available qualities...')}
                  </div>
                ) : availableQualities.length > 0 ? (
                  <div className="quality-options-list">
                    <div className="quality-selector-title">
                      {t('download.downloadOnly.selectQuality', 'Select quality:')}
                    </div>
                    {availableQualities.map((quality, index) => (
                      <div key={index} className="radio-pill">
                        <input
                          type="radio"
                          id={`quality-${index}`}
                          name="quality"
                          checked={selectedQuality?.quality === quality.quality}
                          onChange={() => setSelectedQuality(quality)}
                          disabled={isDownloading}
                        />
                        <label htmlFor={`quality-${index}`} className="quality-pill-label">
                          {quality.label || quality.description || quality.quality}
                        </label>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="no-qualities">
                    {t('download.downloadOnly.noQualities', 'No qualities available')}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="modal-actions">
          {isDownloading ? (
            // Show cancel button during download
            <button
              className="cancel-button"
              onClick={handleCancel}
            >
              {t('download.downloadOnly.cancelDownload', 'Cancel Download')}
            </button>
          ) : (
            // Show close button when not downloading
            <button
              className="cancel-button"
              onClick={handleClose}
            >
              {t('download.downloadOnly.cancel', 'Cancel')}
            </button>
          )}
          <button
            className="confirm-button"
            onClick={handleDownload}
            disabled={!canDownload() || isDownloading}
          >
            {isDownloading ? (
              <span className="processing-text-container">
                <LoadingIndicator
                  theme={isDarkTheme ? 'light' : 'dark'}
                  showContainer={false}
                  size={16}
                  className="buttons-processing-loading"
                  color={waveColor}
                />
                <div className="processing-wavy" style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
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
                    {t('download.downloadOnly.downloading', 'Downloading...')}
                  </span>
                </div>
              </span>
            ) : (
              <>
                <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>download</span>
                {t('download.downloadOnly.download', 'Download')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );

  // Use ReactDOM.createPortal to render the modal directly to the document body
  return ReactDOM.createPortal(
    modalContent,
    document.body
  );
};

export default DownloadOnlyModal;
