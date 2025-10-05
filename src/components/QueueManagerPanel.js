import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import WavyProgressIndicator from './common/WavyProgressIndicator';
import { formatTime as formatDuration } from '../utils/timeFormatter';
import '../styles/QueueManagerPanel.css';

const QueueManagerPanel = ({
  queue,
  currentQueueItem,
  onRemoveItem,
  onClearQueue,
  onCancelItem,
  gridLayout = false
}) => {
  const { t } = useTranslation();

  // Theme detection for WavyProgressIndicator colors
  const [theme, setTheme] = useState(() => {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  });

  // Track locally canceled items so Cancel always has immediate effect
  const [locallyCanceled, setLocallyCanceled] = useState({});
  const isLocallyCanceled = (id) => !!locallyCanceled[id];
  const handleLocalCancel = (item) => {
    setLocallyCanceled((prev) => ({ ...prev, [item.id]: true }));
    if (onCancelItem) onCancelItem(item.id);
  };

  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          const newTheme = document.documentElement.getAttribute('data-theme') || 'dark';
          setTheme(newTheme);
        }
      });
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });

    return () => observer.disconnect();
  }, []);

  const getStatusIcon = (status) => {
    switch (status) {
      case 'pending':
        return (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
        );
      case 'processing':
        return (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2v4"></path>
            <path d="m16.2 7.8 2.9-2.9"></path>
            <path d="M18 12h4"></path>
            <path d="m16.2 16.2 2.9 2.9"></path>
            <path d="M12 18v4"></path>
            <path d="m4.9 19.1 2.9-2.9"></path>
            <path d="M2 12h4"></path>
            <path d="m4.9 4.9 2.9 2.9"></path>
          </svg>
        );
      case 'completed':
        return (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        );
      case 'failed':
        return (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
        );
      case 'canceled':
        return (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="6" y="6" width="12" height="12"></rect>
          </svg>
        );
      default:
        return (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        );
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'pending':
        return 'var(--accent-color)';
      case 'processing':
        return 'var(--warning-color)';
      case 'completed':
        return 'var(--success-color)';
      case 'failed':
        return 'var(--error-color)';
      case 'canceled':
        return 'var(--text-secondary)';
      default:
        return 'var(--text-secondary)';
    }
  };
  // Compute effective status that respects local cancel regardless of server response
  const getEffectiveStatusForItem = (item) => (isLocallyCanceled(item.id) ? 'canceled' : item.status);


  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    // Handle both number timestamps and string timestamps
    const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
    return isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
  };

  // Generate persistent video number based on timestamp
  const getVideoNumber = (item) => {
    // Get or extract timestamp for this item
    let timestamp = item.timestamp;

    // If no timestamp property, try to extract from ID (format: render_TIMESTAMP_randomstring)
    if (!timestamp && item.id) {
      const idParts = item.id.split('_');
      if (idParts.length >= 2 && idParts[0] === 'render') {
        timestamp = parseInt(idParts[1]);
      }
    }

    // Fallback to current time if no timestamp found
    if (!timestamp) {
      timestamp = Date.now();
    }

    // Use localStorage to maintain a persistent counter across sessions
    const STORAGE_KEY = 'videoRenderCounter';
    const TIMESTAMP_MAP_KEY = 'videoTimestampMap';

    // Get existing timestamp-to-number mapping
    let timestampMap = {};
    try {
      const stored = localStorage.getItem(TIMESTAMP_MAP_KEY);
      if (stored) {
        timestampMap = JSON.parse(stored);
      }
    } catch (e) {
      console.warn('Failed to parse timestamp map from localStorage');
    }

    // If this timestamp already has a number assigned, return it
    if (timestampMap[timestamp]) {
      return timestampMap[timestamp];
    }

    // Get current counter value
    let counter = 1;
    try {
      const storedCounter = localStorage.getItem(STORAGE_KEY);
      if (storedCounter) {
        counter = parseInt(storedCounter) + 1;
      }
    } catch (e) {
      console.warn('Failed to parse counter from localStorage');
    }

    // Assign this timestamp the next available number
    timestampMap[timestamp] = counter;

    // Save updated counter and mapping
    try {
      localStorage.setItem(STORAGE_KEY, counter.toString());
      localStorage.setItem(TIMESTAMP_MAP_KEY, JSON.stringify(timestampMap));
    } catch (e) {
      console.warn('Failed to save to localStorage');
    }

    return counter;
  };

  const handleDownloadVideo = async (outputPath, item) => {
    try {
      // Fetch the video as a blob
      const response = await fetch(outputPath);
      if (!response.ok) {
        throw new Error('Failed to fetch video');
      }

      const blob = await response.blob();

      // Create a download link
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `subtitled-video-${getVideoNumber(item)}.mp4`;
      document.body.appendChild(a);
      a.click();

      // Clean up
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    } catch (error) {
      console.error('Error downloading video:', error);
      // Fallback to direct link if fetch fails
      const a = document.createElement('a');
      a.href = outputPath;
      a.download = `subtitled-video-${getVideoNumber(item)}.mp4`;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  return (
    <div className={`queue-manager-panel ${gridLayout ? 'grid-layout' : ''}`}>
      <div className="panel-header">
        <div className="header-left">
          <svg className="panel-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="16" y1="2" x2="16" y2="6"></line>
            <line x1="8" y1="2" x2="8" y2="6"></line>
            <line x1="3" y1="10" x2="21" y2="10"></line>
          </svg>
          <span className="panel-title">{t('videoRendering.renderQueue', 'Render Queue')}</span>
          <span className="queue-count">{queue.length}</span>
        </div>

        {queue.length > 0 && (
          <button
            className="clear-queue-btn header-btn"
            onClick={onClearQueue}
            disabled={currentQueueItem !== null}
            title={t('videoRendering.clearQueue', 'Clear Queue')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        )}
      </div>

      <div className="panel-content">
        {queue.length === 0 ? (
          <div className="empty-queue">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
              <path d="M8 14h.01"></path>
              <path d="M12 14h.01"></path>
              <path d="M16 14h.01"></path>
              <path d="M8 18h.01"></path>
              <path d="M12 18h.01"></path>
              <path d="M16 18h.01"></path>
            </svg>
            <h3>{t('videoRendering.emptyQueue', 'Queue is Empty')}</h3>
            <p>{t('videoRendering.addVideosToQueue', 'Add videos to the queue to start batch rendering')}</p>
          </div>
        ) : (
          <div className={`queue-list ${gridLayout ? 'grid-layout' : ''}`}>
            {queue.map((item) => {
              const effectiveStatus = isLocallyCanceled(item.id) ? 'canceled' : item.status;
              return (
                <div
                  key={item.id}
                  className={`queue-item ${effectiveStatus} ${item.id === currentQueueItem ? 'current' : ''}`}
                >
                  <div className="queue-item-header">
                    <div className="item-info">
                      <span className="status-icon">{getStatusIcon(effectiveStatus)}</span>
                      <div className="item-details">
                        <div className="item-title">
                          {t('videoRendering.subtitledVideo', 'Subtitled Video')} #{getVideoNumber(item)}
                        </div>
                        <div className="item-meta">
                          {item.settings.resolution} • {item.settings.frameRate}fps
                          {item.timestamp && (
                            <span className="item-time"> • {formatTime(item.timestamp)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="item-status">
                      <span
                        className="status-badge"
                        style={{ backgroundColor: getStatusColor(effectiveStatus) }}
                      >
                        {t(`videoRendering.${effectiveStatus}`, effectiveStatus)}
                      </span>
                    </div>
                  </div>

                  {/* Revamped WavyProgressIndicator Section */}
                  {(effectiveStatus === 'processing' || effectiveStatus === 'pending') && (
                    <div className="wavy-progress-section">
                      <WavyProgressIndicator
                        progress={Math.max(0, Math.min(1, (item.progress || 0) / 100))}
                        animate={effectiveStatus === 'processing'}
                        showStopIndicator={true}
                        waveSpeed={1.2}
                        height={12}
                        autoAnimateEntrance={true}
                        color={
                          // Use special blue color for Chrome download phase
                          item.phase === 'chrome-download'
                            ? (theme === 'dark' ? '#2196F3' : '#1976D2')
                            : (theme === 'dark'
                                ? (effectiveStatus === 'processing' ? '#4CAF50' : '#FFC107')
                                : (effectiveStatus === 'processing' ? '#2E7D32' : '#F57C00')
                              )
                        }
                        trackColor={theme === 'dark'
                          ? 'rgba(255, 255, 255, 0.15)'
                          : 'rgba(0, 0, 0, 0.15)'
                        }
                        stopIndicatorColor={
                          // Use same special blue color for Chrome download phase
                          item.phase === 'chrome-download'
                            ? (theme === 'dark' ? '#2196F3' : '#1976D2')
                            : (theme === 'dark'
                                ? (effectiveStatus === 'processing' ? '#4CAF50' : '#FFC107')
                                : (effectiveStatus === 'processing' ? '#2E7D32' : '#F57C00')
                              )
                        }
                        style={{
                          width: '100%'
                        }}
                      />
                      <div className="progress-text">
                        {effectiveStatus === 'processing' ? (
                          <>
                            {/* Fixed percentage container */}
                            <div className="progress-percentage-container">
                              <div className="progress-percentage">
                                {Math.round(item.progress || 0)}%
                              </div>
                            </div>

                            {/* Separate container for frame details */}
                            <div className="progress-frames-container">
                              {item.renderedFrames && item.durationInFrames ? (
                                <div className="progress-frames">
                                  {`${item.renderedFrames}/${item.durationInFrames} ${t('videoRendering.frames', 'frames')}`}
                                </div>
                              ) : item.phaseDescription ? (
                                <div className="progress-frames">
                                  {item.phaseDescription}
                                </div>
                              ) : (
                                <div className="progress-frames">
                                  {t('videoRendering.renderingFrames', 'Processing video frames...')}
                                </div>
                              )}
                              {item.phase === 'encoding' && (
                                <div className="progress-phase encoding">
                                  {t('videoRendering.encodingFrames', 'Encoding and stitching frames...')}
                                </div>
                              )}
                            </div>
                          </>
                        ) : (
                          t('videoRendering.waiting', 'Waiting...')
                        )}
                      </div>
                    </div>
                  )}

                  {/* Error Message */}
                  {item.status === 'failed' && item.error && (
                    <div className="error-section">
                      <div className="error-message">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10"></circle>
                          <line x1="15" y1="9" x2="9" y2="15"></line>
                          <line x1="9" y1="9" x2="15" y2="15"></line>
                        </svg>
                        {item.error}
                      </div>
                    </div>
                  )}

                  {/* Completed Video Info */}
                  {item.status === 'completed' && item.outputPath && (
                    <div className="completed-section">
                      <div className="output-info">
                        {/* Success check icon instead of download icon */}
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                        <span>{t('videoRendering.readyForDownload', 'Ready for download')}</span>
                      </div>
                      <button
                        onClick={() => handleDownloadVideo(item.outputPath, item)}
                        className="download-btn-success"
                        title={t('videoRendering.downloadVideo', 'Download video')}
                      >
                        {/* Download icon inside the button */}
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px' }}>
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                          <polyline points="7 10 12 15 17 10"></polyline>
                          <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        {t('videoRendering.download', 'Download')}
                      </button>
                    </div>
                  )}

                  {/* Item Actions */}
                  <div className="item-actions">
                    {/* Left side: render time when completed */}
                    {item.status === 'completed' && item.startedAt && item.completedAt && (
                      <div className="render-time">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10"></circle>
                          <path d="M12 6v6l4 2"></path>
                        </svg>
                        <span>
                          {t('videoRendering.completedIn', 'Completed in {{time}}', { time: formatDuration((item.completedAt - item.startedAt) / 1000, 'hms') })}
                        </span>
                      </div>
                    )}

                    <div className="item-actions-right">
                      {effectiveStatus === 'processing' && onCancelItem && (
                        <button
                          className="cancel-btn"
                          onClick={() => handleLocalCancel(item)}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="6" y="6" width="12" height="12"></rect>
                          </svg>
                          {t('videoRendering.cancel', 'Cancel')}
                        </button>
                      )}

                      {effectiveStatus !== 'processing' && (
                        <button
                          className="remove-btn"
                          onClick={() => onRemoveItem(item.id)}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                          </svg>
                          {t('videoRendering.remove', 'Remove')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default QueueManagerPanel;
