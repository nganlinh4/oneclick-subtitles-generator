import { useTranslation } from 'react-i18next';
import CustomDropdown from '../common/CustomDropdown';

/**
 * Render-settings row UI: resolution, frame rate, render/cancel buttons.
 * Pure component — all state and handlers come from props.
 */
const RenderSettingsRow = ({
  renderSettings,
  setRenderSettings,
  selectedVideoFile,
  isRendering,
  currentQueueItem,
  onRender,
  onCancelRender,
}) => {
  const { t } = useTranslation();

  return (
    <div className="rendering-row">
      <div className="row-label">
        <label>{t('videoRendering.resolution', 'Resolution')}</label>
      </div>
      <div className="row-content">
        <CustomDropdown
          value={renderSettings.resolution}
          onChange={(value) => setRenderSettings(prev => ({ ...prev, resolution: value }))}
          options={[
            { value: '360p', label: '360p' },
            { value: '480p', label: '480p' },
            { value: '720p', label: '720p' },
            { value: '1080p', label: '1080p' },
            { value: '1440p', label: '1440p' },
            { value: '4K', label: '4K' },
            { value: '8K', label: '8K' }
          ]}
          style={{ marginRight: '1rem' }}
        />

        <label style={{ marginRight: '0.5rem', fontWeight: '500', color: 'var(--text-primary)' }}>
          {t('videoRendering.frameRate', 'Frame Rate')}:
        </label>
        <CustomDropdown
          value={renderSettings.frameRate}
          onChange={(value) => setRenderSettings(prev => ({ ...prev, frameRate: parseInt(value) }))}
          options={[
            { value: 24, label: t('videoRendering.fps24', '24 FPS (Cinema)') },
            { value: 25, label: t('videoRendering.fps25', '25 FPS (PAL)') },
            { value: 30, label: t('videoRendering.fps30', '30 FPS (Standard)') },
            { value: 50, label: t('videoRendering.fps50', '50 FPS (PAL High)') },
            { value: 60, label: t('videoRendering.fps60', '60 FPS (Smooth)') },
            { value: 120, label: t('videoRendering.fps120', '120 FPS (High Speed)') }
          ]}
          style={{ marginRight: '1rem' }}
        />

        <button
          className="pill-button primary"
          onClick={onRender}
          disabled={!selectedVideoFile}
        >
          <span className="material-symbols-rounded">desktop_windows</span>
          {t('videoRendering.render', 'Render')}
        </button>

        {/* Cancel button for current render - only show when actively rendering */}
        {isRendering && currentQueueItem && (
          <button
            className="pill-button cancel"
            onClick={onCancelRender}
            style={{ marginLeft: '0.5rem' }}
          >
            <span className="material-symbols-rounded">stop</span>
            {t('videoRendering.cancel', 'Cancel Current')}
          </button>
        )}

      </div>
    </div>
  );
};

export default RenderSettingsRow;
