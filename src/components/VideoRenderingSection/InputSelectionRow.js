import { useTranslation } from 'react-i18next';
import StandardSlider from '../common/StandardSlider';
import LoadingIndicator from '../common/LoadingIndicator';
import PulsingElement from '../common/PulsingElement';
import HelpIcon from '../common/HelpIcon';

/**
 * First row of the video rendering section: video input, subtitle source,
 * narration selection, and the original-audio / narration volume controls.
 * Pure component — all state, derived values, and handlers come from props.
 */
const InputSelectionRow = ({
  selectedVideoFile,
  handleVideoUpload,
  subtitlesData,
  translatedSubtitles,
  selectedSubtitles,
  setSelectedSubtitles,
  selectedNarration,
  setSelectedNarration,
  renderSettings,
  setRenderSettings,
  isAlignedNarrationAvailable,
  hasNarrationSegments,
  handleRefreshNarration,
  isRefreshingNarration,
  currentNarrationResults,
}) => {
  const { t } = useTranslation();

  return (
    <div className="input-selection-row">
      {/* Video Input */}
      <div className="video-input-compact">
        <h4>{t('videoRendering.videoInput', 'Video Input')}</h4>
        {selectedVideoFile ? (
          <div className="selected-video-info">
            <div className="selected-video-info-row top-row">
              <span className="material-symbols-rounded video-file-icon">video_file</span>
              <span className="video-name">
                {(selectedVideoFile instanceof File ? selectedVideoFile.name :
                  (selectedVideoFile.name || selectedVideoFile.title || 'Current Video'))}
              </span>
            </div>
            <div className="selected-video-info-row bottom-row">
              {selectedVideoFile.isActualVideo && (
                <span className="video-source-indicator">
                  {t('videoRendering.fromPlayer', '(from video player)')}
                </span>
              )}
              <button
                className="pill-button secondary"
                onClick={() => document.getElementById('video-upload-input').click()}
              >
                {t('videoRendering.changeVideo', 'Change')}
              </button>
            </div>
          </div>
        ) : (
          <div className="upload-drop-zone">
            <button
              className="pill-button primary"
              onClick={() => document.getElementById('video-upload-input').click()}
            >
              {t('videoRendering.selectVideo', 'Select Video File')}
            </button>
            <span className="drop-text">
              {t('videoRendering.orDragDrop', 'or drag and drop here')}
            </span>
          </div>
        )}
        <input
          id="video-upload-input"
          type="file"
          accept="video/*"
          onChange={handleVideoUpload}
          style={{ display: 'none' }}
        />
      </div>

      {/* Subtitle Selection */}
      <div className="subtitle-selection-compact">
        <h4>
          {t('videoRendering.subtitleSource', 'Subtitle Source')}
          <HelpIcon title={t('videoRendering.subtitleSourceHelp', 'You can use the Upload SRT/JSON button to upload your own subtitle files')} />
        </h4>
        <div className="radio-group">
          <div className="radio-option">
            <input
              type="radio"
              id="subtitle-original"
              value="original"
              checked={selectedSubtitles === 'original'}
              onChange={(e) => setSelectedSubtitles(e.target.value)}
              disabled={!subtitlesData || subtitlesData.length === 0}
            />
            <label htmlFor="subtitle-original">
              {t('videoRendering.originalSubtitles', 'Original Subtitles')}
              <span className="item-count">
                ({subtitlesData ? subtitlesData.length : 0} {t('videoRendering.items', 'items')})
              </span>
            </label>
          </div>
          <div className="radio-option">
            <input
              type="radio"
              id="subtitle-translated"
              value="translated"
              checked={selectedSubtitles === 'translated'}
              onChange={(e) => setSelectedSubtitles(e.target.value)}
              disabled={!translatedSubtitles || translatedSubtitles.length === 0}
            />
            <label htmlFor="subtitle-translated">
              {t('videoRendering.translatedSubtitles', 'Translated Subtitles')}
              <span className="item-count">
                ({translatedSubtitles ? translatedSubtitles.length : 0} {t('videoRendering.items', 'items')})
              </span>
            </label>
          </div>
        </div>

        {/* Original Audio Volume Control */}
        <div className="compact-volume-control">
          <label className="volume-label">{t('videoRendering.originalAudioVolume', 'Original Audio Volume')}: {renderSettings.originalAudioVolume}%</label>
          <StandardSlider
            value={renderSettings.originalAudioVolume}
            onChange={(value) => setRenderSettings(prev => ({ ...prev, originalAudioVolume: parseInt(value) }))}
            min={0}
            max={100}
            step={1}
            orientation="Horizontal"
            size="XSmall"
            state="Enabled"
            width="compact"
            showValueIndicator={false} // Using custom label
            showIcon={false}
            showStops={false}
            className="original-audio-volume-slider"
            id="original-audio-volume"
            ariaLabel={t('videoRendering.originalAudioVolume', 'Original Audio Volume')}
          />
        </div>
      </div>

      {/* Narration Selection */}
      <div className="narration-selection-compact">
        <h4>{t('videoRendering.narrationSource', 'Narration Audio')}</h4>
        <div className="radio-group">
          <div className="radio-option">
            <input
              type="radio"
              id="narration-none"
              value="none"
              checked={selectedNarration === 'none'}
              onChange={(e) => setSelectedNarration(e.target.value)}
            />
            <label htmlFor="narration-none">
              {t('videoRendering.noNarration', 'No Narration')}
            </label>
          </div>
          {isAlignedNarrationAvailable() && (
            <div className="radio-option">
              <input
                type="radio"
                id="narration-generated"
                value="generated"
                checked={selectedNarration === 'generated'}
                onChange={(e) => setSelectedNarration(e.target.value)}
              />
              <label htmlFor="narration-generated">
                {t('videoRendering.alignedNarration', 'Aligned Narration (ready)')}
              </label>
            </div>
          )}

          {/* Narration status and refresh button - only show when narration is not aligned but available */}
          {!isAlignedNarrationAvailable() && (
            <div className="narration-status-container">
              <span
                className={`narration-status ${!hasNarrationSegments() ? 'disabled' : 'not-aligned'}`}
              >
                {hasNarrationSegments()
                  ? t('videoRendering.narrationNotAligned', 'Narration not aligned')
                  : t('videoRendering.noNarrationGenerated', 'No narration generated')
                }
              </span>
              <PulsingElement
                as="button"
                type="button"
                className="refresh-icon-button"
                onClick={handleRefreshNarration}
                disabled={isRefreshingNarration || !currentNarrationResults || currentNarrationResults.length === 0 || !currentNarrationResults.some(r => r.success && (r.audioData || r.filename))}
                isPulsing={hasNarrationSegments() && !isRefreshingNarration && currentNarrationResults && currentNarrationResults.length > 0 && currentNarrationResults.some(r => r.success && (r.audioData || r.filename))}
                title={
                  !hasNarrationSegments()
                    ? t('videoRendering.generateNarrationFirst', 'Generate narration first')
                    : !currentNarrationResults || currentNarrationResults.length === 0 || !currentNarrationResults.some(r => r.success && (r.audioData || r.filename))
                    ? t('videoRendering.noValidNarrationFiles', 'No valid narration files available')
                    : t('videoRendering.refreshNarration', 'Click to align narration for video rendering')
                }
              >
                {isRefreshingNarration ? (
                  <LoadingIndicator
                    theme="dark"
                    showContainer={false}
                    size={20}
                    className="refresh-loading-indicator"
                  />
                ) : (
                  <span className="material-symbols-rounded">refresh</span>
                )}
              </PulsingElement>
            </div>
          )}

        </div>

        {/* Narration Volume Control */}
        <div className="compact-volume-control">
          <label className="volume-label">{t('videoRendering.narrationVolume', 'Narration Volume')}: {renderSettings.narrationVolume}%</label>
          <StandardSlider
            value={renderSettings.narrationVolume}
            onChange={(value) => setRenderSettings(prev => ({ ...prev, narrationVolume: parseInt(value) }))}
            min={0}
            max={100}
            step={1}
            orientation="Horizontal"
            size="XSmall"
            state={selectedNarration === 'none' ? "Disabled" : "Enabled"}
            width="compact"
            showValueIndicator={false} // Using custom label
            showIcon={false}
            showStops={false}
            className="narration-volume-slider"
            id="narration-volume"
            ariaLabel={t('videoRendering.narrationVolume', 'Narration Volume')}
          />
        </div>
      </div>
    </div>
  );
};

export default InputSelectionRow;
