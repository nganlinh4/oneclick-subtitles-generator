// The render section's title row and its collapse toggle (styled like background-generator-header).
import { useTranslation } from 'react-i18next';

const VideoRenderingHeader = ({ isCollapsed, isClickDisabled, onToggleCollapsed }) => {
  const { t } = useTranslation();
  return (
    <div className="video-rendering-header">
      <div className="header-left">
        <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span className="material-symbols-rounded">movie</span>
          {t('videoRendering.title', 'Video Rendering')}
        </h2>
        <span style={{
          marginLeft: '16px',
          fontSize: '12px',
          color: 'var(--md-on-surface-variant)',
          fontStyle: 'italic',
          opacity: 0.7
        }}>
          {t('videoRendering.upcomingFeatures', 'Export subtitles, narration, styling, and effects into a finished video.')}
        </span>
      </div>
      <button
        className="collapse-button"
        disabled={isClickDisabled}
        onClick={onToggleCollapsed}
        aria-label={isCollapsed ? t('common.expand', 'Expand') : t('common.collapse', 'Collapse')}
        aria-expanded={!isCollapsed}
      >
        <span aria-hidden="true" className="material-symbols-rounded">{isCollapsed ? 'expand_more' : 'stat_1'}</span>
      </button>
    </div>
  );
};

export default VideoRenderingHeader;
