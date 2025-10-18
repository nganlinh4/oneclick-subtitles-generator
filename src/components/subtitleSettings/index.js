import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import '../../styles/SubtitleSettings.css';
import '../../styles/narration/narrationPlaybackMenuRedesign.css';
import '../../styles/narration/alignedNarration.css';
import { SERVER_URL } from '../../config';
import useSubtitleSettings from './hooks/useSubtitleSettings';
import useNarration from './hooks/useNarration';
import NarrationMenu from './components/NarrationMenu';
import SubtitleSettingsPanel from './components/SubtitleSettingsPanel';

/**
 * SubtitleSettings component
 *
 * @param {Object} props - Component props
 * @param {Object} props.settings - Current subtitle settings
 * @param {Function} props.onSettingsChange - Function to handle settings changes
 * @param {boolean} props.hasTranslation - Whether translation is available
 * @param {string} props.targetLanguage - Target language for translation
 * @param {Object} props.videoRef - Reference to the video element
 * @param {Array} props.originalNarrations - Original narration audio files
 * @param {Array} props.translatedNarrations - Translated narration audio files
 * @returns {JSX.Element} - Rendered component
 */
const SubtitleSettings = ({
  settings,
  onSettingsChange,
  hasTranslation,
  targetLanguage,
  videoRef,
  originalNarrations = [],
  translatedNarrations = [],
  onRenderVideo,
  volume,
  setVolume
}) => {
  const { t } = useTranslation();

  // Use custom hooks for subtitle settings and narration
  const {
    isOpen,
    setIsOpen,
    subtitleLanguage,
    handleSettingChange,
    handleSubtitleLanguageChange,
    resetToDefaults
  } = useSubtitleSettings(settings, onSettingsChange);

  const {
    showNarrationMenu,
    setShowNarrationMenu,
    narrationSource,
    setNarrationSource,
    narrationVolume,
    setNarrationVolume,
    currentNarration, // Kept for NarrationMenu props
    hasOriginalNarrations,
    hasTranslatedNarrations,
    hasAnyNarrations,
    // Only aligned narration props we need
    isGeneratingAligned,
    alignedStatus
  } = useNarration(videoRef, originalNarrations, translatedNarrations, SERVER_URL);

  // Update subtitle language when translation becomes available
  useEffect(() => {
    if (hasTranslation && settings.showTranslatedSubtitles && subtitleLanguage !== 'translated') {
      handleSubtitleLanguageChange({ target: { value: 'translated' } });
    }
  }, [hasTranslation, settings.showTranslatedSubtitles, subtitleLanguage, handleSubtitleLanguageChange]);

  // No need for individual narration playback code anymore
  // Aligned narration is handled by the useAlignedNarration hook

  return (
    <div className="subtitle-settings-container">
      <div className="action-buttons">
        {/* Subtitle Settings Toggle Button */}
        <button
          className={`action-button subtitle-settings-toggle md-filled-tonal-button ${isOpen ? 'active' : ''}`}
          onClick={() => {
            const newIsOpen = !isOpen;
            setIsOpen(newIsOpen);
            // Close narration menu if it's open
            if (showNarrationMenu) {

              setShowNarrationMenu(false);
            }

          }}
          title={t('subtitleSettings.settingsTooltip', 'Customize subtitle appearance')}
        >
          <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>subtitles_gear</span>
          <span>{t('subtitleSettings.toggleSettings', 'Subtitle Settings')}</span>
        </button>

        {/* Narration Menu */}
        <NarrationMenu
          showNarrationMenu={showNarrationMenu}
          setShowNarrationMenu={setShowNarrationMenu}
          narrationSource={narrationSource}
          setNarrationSource={setNarrationSource}
          narrationVolume={narrationVolume}
          setNarrationVolume={setNarrationVolume}
          videoVolume={volume}
          setVideoVolume={setVolume}
          currentNarration={currentNarration}
          hasOriginalNarrations={hasOriginalNarrations}
          hasTranslatedNarrations={hasTranslatedNarrations}
          hasAnyNarrations={hasAnyNarrations}
          isGeneratingAligned={isGeneratingAligned}
          alignedStatus={alignedStatus}
          isSubtitleSettingsOpen={isOpen}
          setIsSubtitleSettingsOpen={setIsOpen}
        />

        {/* Render Video Button */}
        <button
          className="action-button render-video-toggle md-filled-tonal-button"
          onClick={() => {
            // Close any open panels
            if (isOpen) setIsOpen(false);
            if (showNarrationMenu) setShowNarrationMenu(false);
            // Trigger render video action
            if (onRenderVideo) onRenderVideo();
          }}
          title={t('videoRendering.renderTooltip', 'Render video with subtitles and narration')}
        >
          <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>movie</span>
          <span>{t('videoRendering.renderVideo', 'Render Video')}</span>
        </button>
      </div>

      {/* Subtitle Settings Panel */}
      <SubtitleSettingsPanel
        isOpen={isOpen}
        setIsOpen={setIsOpen}
        settings={settings}
        handleSettingChange={handleSettingChange}
        subtitleLanguage={subtitleLanguage}
        handleSubtitleLanguageChange={handleSubtitleLanguageChange}
        hasTranslation={hasTranslation}
        targetLanguage={targetLanguage}
        resetToDefaults={resetToDefaults}
      />
    </div>
  );
};

export default SubtitleSettings;
