import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import WavyProgressIndicator from './common/WavyProgressIndicator';
import CloseButton from './common/CloseButton';

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

  // Preview modal state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewItem, setPreviewItem] = useState(null);
  const [previewInfo, setPreviewInfo] = useState(null); // from server (ffprobe)
  const [previewInfoLoading, setPreviewInfoLoading] = useState(false);
  const [previewClientInfo, setPreviewClientInfo] = useState(null); // from video element
  const [previewExtra, setPreviewExtra] = useState(null); // size, createdAt from /video-exists

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

  // Track shown error toasts to avoid duplicates
  const [shownErrorToasts, setShownErrorToasts] = useState(new Set());

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

  // Show toast for newly failed items
  useEffect(() => {
    queue.forEach((item) => {
      if (item.status === 'failed' && item.error && !shownErrorToasts.has(item.id)) {
        window.addToast(`Video rendering failed: ${item.error}`, 'error', 8000);
        setShownErrorToasts(prev => new Set([...prev, item.id]));
      }
    });
  }, [queue, shownErrorToasts]);

  const getStatusIcon = (status) => {
    switch (status) {
      case 'pending':
        return (
          <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>schedule</span>
        );
      case 'processing':
        return (
          <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>hourglass_top</span>
        );
      case 'completed':
        return (
          <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>check</span>
        );
      case 'failed':
        return (
          <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>error</span>
        );
      case 'canceled':
        return (
          <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>block</span>
        );
      default:
        return (
          <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>description</span>
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
      // ignore
    }

    if (timestampMap[timestamp]) {
      return timestampMap[timestamp];
    }

    let counter = 1;
    try {
      const storedCounter = localStorage.getItem(STORAGE_KEY);
      if (storedCounter) {
        counter = parseInt(storedCounter) + 1;
      }
    } catch (e) {
      // ignore
    }

    timestampMap[timestamp] = counter;

    try {
      localStorage.setItem(STORAGE_KEY, counter.toString());
      localStorage.setItem(TIMESTAMP_MAP_KEY, JSON.stringify(timestampMap));
    } catch (e) {
      // ignore
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

  // Helpers for preview info via server (ffprobe-backed)
  const extractVideoIdFromUrl = (url) => {
    try {
      if (!url) return null;
      if (!url.includes('/videos/')) return null;
      let full = url.split('/videos/')[1];
      if (full.includes('?')) full = full.split('?')[0];
      if (full.endsWith('.mp4')) full = full.slice(0, -4);
      const m = full.match(/(.+)_\d{13}$/);
      return m ? m[1] : full;
    } catch {
      return null;
    }
  };

  const fetchPreviewInfo = async (url) => {
    // If it's a server-hosted /videos/ URL, use id-based endpoint
    if (url && url.includes('/videos/')) {
      const id = extractVideoIdFromUrl(url);
      if (!id) return null;
      const endpoints = [
        `${window.location.origin}/api/video-dimensions/${id}`,
        `http://localhost:3031/api/video-dimensions/${id}`
      ];
      for (const ep of endpoints) {
        try {
          const res = await fetch(ep);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (data && data.success) {
            setPreviewInfo(data);
            return data;
          }
        } catch (e) {
          // try next endpoint
          continue;
        }
      }
      return null;
    }

    // Otherwise, probe the absolute URL via /api/probe-media
    try {
      const absolute = url.startsWith('http') ? url : `${window.location.origin}${url}`;
      const endpoints = [
        `${window.location.origin}/api/probe-media?url=${encodeURIComponent(absolute)}`,
        `http://localhost:3031/api/probe-media?url=${encodeURIComponent(absolute)}`
      ];
      for (const ep of endpoints) {
        try {
          const res = await fetch(ep);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (data && data.success) {
            setPreviewInfo(data);
            return data;
          }
        } catch (e) {
          // try next endpoint
          continue;
        }
      }
    } catch (e) {
      // ignore
    }
    return null;
  };

  const fetchPreviewExtra = async (url) => {
    const id = extractVideoIdFromUrl(url);
    if (!id) return null;
    try {
      const res = await fetch(`${window.location.origin}/api/video-exists/${id}`);
      const data = await res.json();
      if (data && data.exists) {
        setPreviewExtra({ size: data.size, createdAt: data.createdAt });
        return data;
      }
      setPreviewExtra(null);
      return null;
    } catch (e) {
      setPreviewExtra(null);
      return null;
    }
  };

  const [previewDuration, setPreviewDuration] = useState(null);

  // Helpers
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const getAspectRatio = (w, h) => {
    if (!w || !h) return null;
    const g = gcd(w, h);
    return `${Math.round(w / g)}:${Math.round(h / g)}`;
  };
  const heightToQuality = (h) => {
    if (!h) return 'Unknown';
    if (h >= 2160) return '4K';
    if (h >= 1440) return '1440p';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
    if (h >= 480) return '480p';
    if (h >= 360) return '360p';
    return `${h}p`;
  };
  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes)) return null;
    const units = ['B','KB','MB','GB','TB'];
    let i = 0; let val = bytes;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[i]}`;
  };

  // Fallback: try a HEAD request to get Content-Length and Last-Modified
  const fetchHeadInfo = async (url) => {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      const len = res.headers.get('content-length');
      const lm = res.headers.get('last-modified');
      const size = len ? parseInt(len) : null;
      setPreviewExtra({
        size: Number.isFinite(size) ? size : null,
        createdAt: lm || null
      });
    } catch (_) {
      // ignore
    }
  };

  useEffect(() => {
    if (previewOpen && previewUrl) {
      const isServerVideo = previewUrl.includes('/videos/');

      // Fetch detailed info (supports /videos and non-/videos via probe)
      fetchPreviewInfo(previewUrl);

      // Extra file info from server only for /videos (size/created also comes from HEAD below)
      if (isServerVideo) {
        fetchPreviewExtra(previewUrl);
      }

      // Always try HEAD when it's http(s) (works for both absolute and same-origin URLs)
      if (/^https?:/.test(previewUrl) || previewUrl.startsWith('/')) {
        const absolute = previewUrl.startsWith('http') ? previewUrl : `${window.location.origin}${previewUrl}`;
        fetchHeadInfo(absolute);
      }
    } else {
      setPreviewInfo(null);
      setPreviewExtra(null);
      setPreviewDuration(null);
    }
  }, [previewOpen, previewUrl]);

  return (
    <>
    <div className={`queue-manager-panel ${gridLayout ? 'grid-layout' : ''}`}>
      <div className="panel-header">
        <div className="header-left">
          <span className="material-symbols-rounded panel-icon" style={{ fontSize: '18px' }}>video_library</span>
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
            <span className="material-symbols-rounded" style={{ fontSize: '22px' }}>delete_sweep</span>
          </button>
        )}
      </div>

      <div className="panel-content">
        {queue.length === 0 ? (
          <div className="empty-queue">
            <span className="material-symbols-rounded" style={{ fontSize: '48px' }}>stack_off</span>
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


                  {/* Completed Video Info */}
                  {item.status === 'completed' && item.outputPath && (
                    <div className="completed-section">
                      <button
                        type="button"
                        className="preview-btn"
                        onClick={() => { setPreviewUrl(item.outputPath); setPreviewItem(item); setPreviewOpen(true); }}
                        title={t('videoRendering.preview', 'Preview')}
                      >
                        <div className="preview-thumb-wrap">
                          <video
                            className="preview-thumb"
                            src={item.outputPath + '#t=0.1'}
                            muted
                            playsInline
                            preload="metadata"
                          />
                        </div>
                        <span className="preview-text">
                          {t('videoRendering.preview', 'Preview')}
                        </span>
                      </button>

                      <button
                        onClick={() => handleDownloadVideo(item.outputPath, item)}
                        className="download-btn-success"
                        title={t('videoRendering.downloadVideo', 'Download video')}
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: '16px', marginRight: '6px' }}>download</span>
                        {t('videoRendering.download', 'Download')}
                      </button>
                    </div>
                  )}

                  {/* Item Actions */}
                  <div className="item-actions">
                    {/* Left side: render time when completed */}
                    {item.status === 'completed' && item.startedAt && item.completedAt && (
                      <div className="render-time">
                        <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>schedule</span>
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
                          <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>cancel</span>
                          {t('videoRendering.cancel', 'Cancel')}
                        </button>
                      )}

                      {effectiveStatus !== 'processing' && (
                        <button
                          className="remove-btn"
                          onClick={() => onRemoveItem(item.id)}
                        >
                          <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>delete</span>
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
      {previewOpen && (
        <div className="preview-modal-overlay" onClick={() => setPreviewOpen(false)}>
          <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="preview-modal-header">
              <div className="preview-title" style={{ gap: '1rem', padding: '0 16px' }}>
                <span className="material-symbols-rounded" style={{ fontSize: '48px' }}>live_tv</span>
                <span>{t('videoRendering.preview', 'Preview')}</span>
                {/* Video info badges (always render container; fill when data available) */}
                <div className="preview-badges">
                  {(() => {
                    const info = previewInfo || previewClientInfo;

                    const videoBasics = [];
                    const videoCodecs = [];
                    const audioBadges = [];
                    const fileBadges = [];

                    // VIDEO BASICS (order: res, fps, duration, quality)
                    if (info?.width && info?.height) {
                      videoBasics.push(
                        <span key="res" className="preview-badge video" title={t('videoRendering.resolutionLabel','Resolution')}>
                          {info.width}×{info.height}
                          {getAspectRatio(info.width, info.height) ? ` (${getAspectRatio(info.width, info.height)})` : ''}
                        </span>
                      );
                    }
                    if (info?.fps) {
                      videoBasics.push(
                        <span key="fps" className="preview-badge video" title={t('videoRendering.frameRateLabel','Frame rate')}>{info.fps} fps</span>
                      );
                    }
                    if (typeof previewDuration === 'number' && !isNaN(previewDuration)) {
                      videoBasics.push(
                        <span key="dur" className="preview-badge video" title={t('videoRendering.durationLabel','Duration')}>{formatDuration(previewDuration, 'hms')}</span>
                      );
                    }
                    if (info?.quality || (info?.height && !info?.quality)) {
                      videoBasics.push(
                        <span key="quality" className="preview-badge video" title={t('videoRendering.qualityLabel','Quality')}>{info.quality || heightToQuality(info.height)}</span>
                      );
                    }

                    // FILE (then)
                    if (previewExtra?.size) {
                      fileBadges.push(
                        <span key="size" className="preview-badge file" title={t('videoRendering.fileSizeLabel','File size')}>{formatBytes(previewExtra.size)}</span>
                      );
                    }
                    if (previewExtra?.createdAt) {
                      const d = new Date(previewExtra.createdAt);
                      if (!isNaN(d.getTime())) {
                        fileBadges.push(
                          <span key="created" className="preview-badge file" title={t('videoRendering.createdAtLabel','Created at')}>{d.toLocaleString()}</span>
                        );
                      }
                    }

                    // VIDEO CODECS
                    if (info?.codec) {
                      videoCodecs.push(
                        <span key="vcodec" className="preview-badge video" title={t('videoRendering.videoCodecLabel','Video codec')}>{info.codec}</span>
                      );
                    }
                    if (info?.bit_rate) {
                      videoCodecs.push(
                        <span key="vbitrate" className="preview-badge video" title={t('videoRendering.videoBitrateLabel','Video bitrate')}>{Math.round(info.bit_rate / 1000)} kbps</span>
                      );
                    } else if (previewExtra?.size && typeof previewDuration === 'number' && previewDuration > 0) {
                      const kbps = Math.round((previewExtra.size * 8) / previewDuration / 1000);
                      videoCodecs.push(
                        <span key="est-bitrate" className="preview-badge video" title={t('videoRendering.estimatedBitrateLabel','Estimated bitrate')}>{kbps} kbps</span>
                      );
                    }

                    // AUDIO
                    if (info?.audio_codec) {
                      audioBadges.push(
                        <span key="acodec" className="preview-badge audio" title={t('videoRendering.audioCodecLabel','Audio codec')}>{info.audio_codec}</span>
                      );
                    }
                    if (Number.isFinite(info?.audio_channels)) {
                      audioBadges.push(
                        <span key="achannels" className="preview-badge audio" title={t('videoRendering.audioChannelsLabel','Audio channels')}>{info.audio_channels} ch{info.audio_channel_layout ? ` (${info.audio_channel_layout})` : ''}</span>
                      );
                    }
                    if (Number.isFinite(info?.audio_sample_rate)) {
                      const khz = Math.round((info.audio_sample_rate / 1000) * 10) / 10;
                      audioBadges.push(
                        <span key="asamplerate" className="preview-badge audio" title={t('videoRendering.audioSampleRateLabel','Audio sample rate')}>{khz} kHz</span>
                      );
                    }
                    if (Number.isFinite(info?.audio_bit_rate)) {
                      audioBadges.push(
                        <span key="abitrate" className="preview-badge audio" title={t('videoRendering.audioBitrateLabel','Audio bitrate')}>{Math.round(info.audio_bit_rate / 1000)} kbps</span>
                      );
                    }

                    // FILE container (last)
                    if (previewUrl) {
                      const extMatch = previewUrl.toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/);
                      if (extMatch && extMatch[1]) {
                        fileBadges.push(
                          <span key="container" className="preview-badge file" title={t('videoRendering.containerLabel','Container')}>{extMatch[1].toUpperCase()}</span>
                        );
                      }
                    }

                    const ordered = [];
                    if (videoBasics.length) ordered.push(...videoBasics);
                    if (videoCodecs.length) {
                      if (ordered.length) ordered.push(<span key="sep-vcodec" className="preview-sep" />);
                      ordered.push(...videoCodecs);
                    }
                    if (audioBadges.length) {
                      if (ordered.length) ordered.push(<span key="sep-audio" className="preview-sep" />);
                      ordered.push(...audioBadges);
                    }
                    if (fileBadges.length) {
                      if (ordered.length) ordered.push(<span key="sep-file" className="preview-sep" />);
                      ordered.push(...fileBadges);
                    }
                    return ordered;
                  })()}
                </div>
              </div>
              <CloseButton
                onClick={() => setPreviewOpen(false)}
                variant="modal"
                size="medium"
                className="preview-close-btn"
              />
            </div>
            <div className="preview-modal-content">
              <video
                src={previewUrl}
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  setPreviewDuration(v.duration || null);
                  const vw = v.videoWidth || null;
                  const vh = v.videoHeight || null;
                  const fps = (previewItem && previewItem.settings && previewItem.settings.frameRate) ? previewItem.settings.frameRate : undefined;
                  if (vw && vh) {
                    setPreviewClientInfo({ width: vw, height: vh, fps });
                  }
                }}
                controls
                style={{ width: '100%', height: 'auto', borderRadius: 24, maxHeight: '75vh' }}
              />
            </div>
          </div>
        </div>
      )}

    </>
  );
};

export default QueueManagerPanel;
