import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from '../../common/SliderWithValue';
import MaterialSwitch from '../../common/MaterialSwitch';
import { DisplayIcon } from '../icons/TabIcons';
import CustomGeminiModelsCard from '../components/CustomGeminiModelsCard';
import CustomDropdown from '../../common/CustomDropdown';
import { initGeminiButtonEffects, disableGeminiButtonEffects } from '../../../utils/geminiEffects';
import VideoAnalysisCard from './VideoAnalysisCard';
import ThinkingBudgetCard from './ThinkingBudgetCard';
import '../../../styles/common/material-switch.css';
import '../../../styles/settings/customGeminiModels.css';

const VideoProcessingTab = ({
  segmentDuration,
  setSegmentDuration,
  geminiModel,
  setGeminiModel,
  timeFormat,
  setTimeFormat,
  showWaveformLongVideos,
  setShowWaveformLongVideos,
  useVideoAnalysis,
  setUseVideoAnalysis,
  videoAnalysisModel,
  setVideoAnalysisModel,
  videoAnalysisTimeout,
  setVideoAnalysisTimeout,
  optimizeVideos,
  setOptimizeVideos,
  optimizedResolution,
  setOptimizedResolution,
  useOptimizedPreview,
  setUseOptimizedPreview,
  thinkingBudgets,
  setThinkingBudgets,
  useCookiesForDownload,
  setUseCookiesForDownload,
  enableYoutubeSearch,
  setEnableYoutubeSearch,
  autoImportSiteSubtitles,
  setAutoImportSiteSubtitles,
  customGeminiModels = [],
  setCustomGeminiModels,
  // New prop for gemini effects toggle
  enableGeminiEffects,
  setEnableGeminiEffects,
  // New prop for favorite max subtitle length
  favoriteMaxSubtitleLength,
  setFavoriteMaxSubtitleLength,
  showFavoriteMaxLength,
  setShowFavoriteMaxLength
}) => {
  const { t } = useTranslation();

  // Apply Gemini effects immediately when toggle changes
  useEffect(() => {
    if (enableGeminiEffects) {
      initGeminiButtonEffects();
    } else {
      disableGeminiButtonEffects();
    }
  }, [enableGeminiEffects]);

  return (
    <div className="settings-section video-processing-section">

      {/* Grid layout for settings cards */}
      <div className="video-processing-grid">

        {/* Video Analysis Card - FIRST */}
        <VideoAnalysisCard
          videoAnalysisModel={videoAnalysisModel}
          setVideoAnalysisModel={setVideoAnalysisModel}
          videoAnalysisTimeout={videoAnalysisTimeout}
          setVideoAnalysisTimeout={setVideoAnalysisTimeout}
        />

        {/* Processing Settings Card - SECOND */}
        <div className="settings-card processing-card">
          <div className="settings-card-header">
            <div className="settings-card-icon">
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>text_fields</span>
            </div>
            <h4>{t('settings.processingSettings', 'Processing')}</h4>
          </div>
          <div className="settings-card-content">
            {/* Auto Split Subtitles Setting */}
            <div className="compact-setting">
              <div className="setting-header">
                <label htmlFor="auto-split-subtitles">
                  {t('settings.autoSplitSubtitles', 'Auto-split subtitles')}
                </label>
                <div className="material-switch-container">
                  <MaterialSwitch
                    id="auto-split-subtitles"
                    checked={showFavoriteMaxLength}
                    onChange={(e) => setShowFavoriteMaxLength(e.target.checked)}
                    ariaLabel={t('settings.autoSplitSubtitles', 'Auto-split subtitles')}
                    icons={true}
                  />
                </div>
              </div>
              <p className="setting-description">
                {t('settings.autoSplitSubtitlesDescription', 'Automatically split long subtitles into smaller segments for better readability.')}
              </p>
            </div>

            {/* Favorite Max Subtitle Length Setting */}
            <div className="compact-setting">
              <label htmlFor="favorite-max-subtitle-length">
                {t('settings.favoriteMaxSubtitleLength', 'Favorite max length of one subtitle')}
              </label>
              <p className="setting-description">
                {t('settings.favoriteMaxSubtitleLengthDescription', 'Set the default maximum number of words per subtitle when auto-split is enabled.')}
              </p>
              <SliderWithValue
                value={favoriteMaxSubtitleLength}
                onChange={(value) => setFavoriteMaxSubtitleLength(parseInt(value))}
                min={1}
                max={30}
                step={1}
                orientation="Horizontal"
                size="Small"
                state={showFavoriteMaxLength ? "Enabled" : "Disabled"}
                className="max-subtitle-length-slider"
                id="favorite-max-subtitle-length"
                ariaLabel={t('settings.favoriteMaxSubtitleLength', 'Favorite max length of one subtitle')}
                disabled={!showFavoriteMaxLength}
                formatValue={(v) => `${v} ${t('settings.words', 'words')}`}
              />
            </div>
          </div>
        </div>

        {/* Display Settings Card - THIRD */}
        <div className="settings-card display-card">
          <div className="settings-card-header">
            <div className="settings-card-icon">
              <DisplayIcon />
            </div>
            <h4>{t('settings.displaySettings', 'Display Settings')}</h4>
          </div>
          <div className="settings-card-content">
            {/* Time Format Setting */}
            <div className="compact-setting">
              <label htmlFor="time-format">
                {t('settings.timeFormat', 'Time Format')}
              </label>
              <p className="setting-description">
                {t('settings.timeFormatDescription', 'Choose how time is displayed in the timeline and lyrics.')}
              </p>
              <CustomDropdown
                value={timeFormat}
                onChange={(value) => setTimeFormat(value)}
                options={[
                  { value: 'seconds', label: t('settings.timeFormatSeconds', 'Seconds (e.g., 75.40s)') },
                  { value: 'hms', label: t('settings.timeFormatHMS', 'HH:MM:SS (e.g., 1:15.40)') }
                ]}
                placeholder={t('settings.selectTimeFormat', 'Select Time Format')}
              />
            </div>

            {/* Audio Waveform for Long Videos Setting */}
            <div className="compact-setting">
              <div className="setting-header">
                <label htmlFor="show-waveform-long-videos">
                  {t('settings.showWaveformLongVideos', 'Show Waveform for Videos Longer than 30 Minutes')}
                </label>
                <div className="material-switch-container">
                  <MaterialSwitch
                    id="show-waveform-long-videos"
                    checked={showWaveformLongVideos}
                    onChange={(e) => setShowWaveformLongVideos(e.target.checked)}
                    ariaLabel={t('settings.showWaveformLongVideos', 'Show Waveform for Videos Longer than 30 Minutes')}
                    icons={true}
                  />
                </div>
              </div>
              <p className="setting-description">
                {t('settings.showWaveformLongVideosDescription', 'Enable waveform visualization for videos longer than 30 minutes. This may impact performance on very long videos.')}
              </p>
            </div>

            {/* Show Gemini star effects Setting */}
            <div className="compact-setting">
              <div className="setting-header">
                <label htmlFor="enable-gemini-effects">
                  {t('settings.showGeminiEffects', 'Show Gemini star effects')}
                </label>
                <div className="material-switch-container">
                  <MaterialSwitch
                    id="enable-gemini-effects"
                    checked={enableGeminiEffects}
                    onChange={(e) => setEnableGeminiEffects(e.target.checked)}
                    ariaLabel={t('settings.showGeminiEffects', 'Show Gemini star effects')}
                    icons={true}
                  />
                </div>
              </div>
              <p className="setting-description">
                {t('settings.showGeminiEffectsDescription', 'Use Gemini starry sky effect and Gemini stars button effect. This can be turned off for low end devices and no functionalities will be affected')}
              </p>
            </div>
          </div>
        </div>

        {/* Download Settings Card - FOURTH */}
        <div className="settings-card download-card">
          <div className="settings-card-header">
            <div className="settings-card-icon">
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>download</span>
            </div>
            <h4>{t('settings.downloadSettings', 'Download Settings')}</h4>
          </div>
          <div className="settings-card-content">
            {/* Auto-import site subtitles (new) */}
            <div className="compact-setting">
              <div className="setting-header">
                <label htmlFor="auto-import-site-subtitles">
                  {t('settings.autoImportSiteSubtitles', 'Auto-import site subtitles (when available)')}
                </label>
                <div className="material-switch-container">
                  <MaterialSwitch
                    id="auto-import-site-subtitles"
                    checked={autoImportSiteSubtitles}
                    onChange={(e) => setAutoImportSiteSubtitles(e.target.checked)}
                    ariaLabel={t('settings.autoImportSiteSubtitles', 'Auto-import site subtitles (when available)')}
                    icons={true}
                  />
                </div>
              </div>
              <p className="setting-description">
                {t('settings.autoImportSiteSubtitlesDescription', 'When available, automatically fetch and prefill subtitles that come from the site while the video is downloading. You can replace them later by uploading your own or regenerating.')}
              </p>
            </div>

            {/* Enable YouTube Search Setting */}
            <div className="compact-setting">
              <div className="setting-header">
                <label htmlFor="enable-youtube-search">
                  {t('settings.enableYoutubeSearch', 'Enable YouTube Search')}
                </label>
                <div className="material-switch-container">
                  <MaterialSwitch
                    id="enable-youtube-search"
                    checked={enableYoutubeSearch}
                    onChange={(e) => setEnableYoutubeSearch(e.target.checked)}
                    ariaLabel={t('settings.enableYoutubeSearch', 'Enable YouTube Search')}
                    icons={true}
                  />
                </div>
              </div>
              <p className="setting-description">
                {t('settings.enableYoutubeSearchDescription', 'Show the "Search YouTube" tab in input methods and enable YouTube API authentication settings. Disabling this will hide YouTube search functionality.')}
              </p>
            </div>

            {/* Download Cookies Setting */}
            <div className="compact-setting">
              <div className="setting-header">
                <label htmlFor="use-cookies-download">
                  {t('settings.useCookiesForDownload', 'Use browser cookies for video downloads')}
                </label>
                <div className="material-switch-container">
                  <MaterialSwitch
                    id="use-cookies-download"
                    checked={useCookiesForDownload}
                    onChange={(e) => setUseCookiesForDownload(e.target.checked)}
                    ariaLabel={t('settings.useCookiesForDownload', 'Use browser cookies for video downloads')}
                    icons={true}
                  />
                </div>
              </div>
              <p className="setting-description">
                {t('settings.useCookiesForDownloadDescription', 'Enable browser cookie authentication to access higher quality videos and bypass login restrictions. Disabling this will make downloads faster but may limit available video qualities and cause failures on restricted content.')}
              </p>
            </div>
          </div>
        </div>

        {/* AI Thinking Budget Card - FIFTH */}
        <ThinkingBudgetCard
          thinkingBudgets={thinkingBudgets}
          setThinkingBudgets={setThinkingBudgets}
        />

        {/* Custom Gemini Models Card - SIXTH */}
        <CustomGeminiModelsCard
          customGeminiModels={customGeminiModels}
          setCustomGeminiModels={setCustomGeminiModels}
        />
      </div>
    </div>
  );
};

export default VideoProcessingTab;
