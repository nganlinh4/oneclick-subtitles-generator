import { useTranslation } from 'react-i18next';
import WavyProgressIndicator from '../common/WavyProgressIndicator';
import { formatTime as formatDuration } from '../../utils/timeFormatter';
import { getStatusIcon, getStatusColor, getVideoNumber, formatTime } from './queueHelpers';

const QueueItemRow = ({
  item,
  effectiveStatus,
  currentQueueItem,
  theme,
  onCancelItem,
  onRemoveItem,
  onLocalCancel,
  onPreview,
  onDownloadVideo
}) => {
  const { t } = useTranslation();

  return (
    <div
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
            onClick={() => onPreview(item)}
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
            onClick={() => onDownloadVideo(item.outputPath, item)}
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
              onClick={() => onLocalCancel(item)}
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
};

export default QueueItemRow;
