import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import '../styles/QueueManagerPanel.css';
import { getVideoNumber } from './queue/queueHelpers';
import { fetchPreviewInfo, fetchPreviewExtra, fetchHeadInfo } from './queue/previewDataFetching';
import QueueItemRow from './queue/QueueItemRow';
import PreviewModal from './queue/PreviewModal';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import { exportMediaAsset } from '../platform/mediaExportService';
import { isNativeMediaPlaybackUrl } from '../platform/mediaService';
import { fetchBrowserResource } from '../platform/browserFetch';

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
  const [previewClientInfo, setPreviewClientInfo] = useState(null); // from video element
  const [previewExtra, setPreviewExtra] = useState(null); // size, createdAt from /video-exists
  const [previewDuration, setPreviewDuration] = useState(null);

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

  const handleDownloadVideo = async (outputPath, item) => {
    try {
      if (isDesktopRuntime()) {
        if (!item?.outputAssetId) throw new Error('Native rendered media is unavailable');
        await exportMediaAsset(item.outputAssetId);
        return;
      }
      if (isNativeMediaPlaybackUrl(outputPath)) {
        throw new Error('Native rendered media requires native export');
      }
      // Fetch the video as a blob
      const response = await fetchBrowserResource(outputPath);
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
      if (isDesktopRuntime() || isNativeMediaPlaybackUrl(outputPath)) return;
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

  const handlePreview = (item) => {
    setPreviewUrl(item.outputPath);
    setPreviewItem(item);
    setPreviewOpen(true);
  };

  useEffect(() => {
    if (previewOpen && previewUrl) {
      const isServerVideo = previewUrl.includes('/videos/');

      // Fetch detailed info (supports /videos and non-/videos via probe)
      fetchPreviewInfo(previewUrl, previewItem?.outputAssetId).then((data) => {
        if (data) setPreviewInfo(data);
      });

      // Extra file info from server only for /videos (size/created also comes from HEAD below)
      if (isServerVideo) {
        fetchPreviewExtra(previewUrl, {
          assetId: previewItem?.outputAssetId,
          sizeBytes: previewItem?.outputSizeBytes,
        }).then((data) => {
          setPreviewExtra(data);
        });
      }

      // Always try HEAD when it's http(s) (works for both absolute and same-origin URLs)
      if (/^https?:/.test(previewUrl) || previewUrl.startsWith('/')) {
        const absolute = previewUrl.startsWith('http') ? previewUrl : `${window.location.origin}${previewUrl}`;
        fetchHeadInfo(absolute, {
          assetId: previewItem?.outputAssetId,
          sizeBytes: previewItem?.outputSizeBytes,
        }).then((data) => {
          if (data) setPreviewExtra(data);
        });
      }
    } else {
      setPreviewInfo(null);
      setPreviewExtra(null);
      setPreviewDuration(null);
    }
  }, [previewItem, previewOpen, previewUrl]);

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
                <QueueItemRow
                  key={item.id}
                  item={item}
                  effectiveStatus={effectiveStatus}
                  currentQueueItem={currentQueueItem}
                  theme={theme}
                  onCancelItem={onCancelItem}
                  onRemoveItem={onRemoveItem}
                  onLocalCancel={handleLocalCancel}
                  onPreview={handlePreview}
                  onDownloadVideo={handleDownloadVideo}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
      {previewOpen && (
        <PreviewModal
          previewUrl={previewUrl}
          previewItem={previewItem}
          previewInfo={previewInfo}
          previewClientInfo={previewClientInfo}
          previewExtra={previewExtra}
          previewDuration={previewDuration}
          setPreviewDuration={setPreviewDuration}
          setPreviewClientInfo={setPreviewClientInfo}
          onClose={() => setPreviewOpen(false)}
        />
      )}

    </>
  );
};

export default QueueManagerPanel;
