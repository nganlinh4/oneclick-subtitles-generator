import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import StandardSlider from '../../common/StandardSlider';
import MaterialSwitch from '../../common/MaterialSwitch';
import { DisplayIcon, VideoAnalysisIcon } from '../icons/TabIcons';
import { FiCpu, FiDownload, FiType } from 'react-icons/fi';
import CustomGeminiModelsCard from '../components/CustomGeminiModelsCard';
import CustomDropdown from '../../common/CustomDropdown';
import { initGeminiButtonEffects, disableGeminiButtonEffects } from '../../../utils/geminiEffects';
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
  customGeminiModels,
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

  // Helper function to get analysis models (subset of all models)
  const getAnalysisModels = () => {
    const builtInAnalysisModels = [
      { id: 'gemini-2.5-flash', name: t('settings.modelFlash25', 'Gemini 2.5 Flash (Best)') },
      { id: 'gemini-2.5-flash-lite', name: t('settings.modelFlash25LiteSettings', 'Gemini 2.5 Flash Lite (Fast + Efficient)') },
      { id: 'gemini-2.0-flash', name: t('settings.modelFlash', 'Gemini 2.0 Flash (Normal)') }
    ];

    const customModels = customGeminiModels.map(model => ({
      id: model.id,
      name: `${model.name} (Custom)`,
      isCustom: true
    }));

    return [...builtInAnalysisModels, ...customModels];
  };

  // Helper function to get the dropdown mode for a thinking budget value
  const getThinkingMode = (budget) => {
    if (budget === -1) return 'dynamic';
    if (budget === 0) return 'disabled';
    return 'custom';
  };

  // Helper function to get the slider value for custom mode (map token count to 0-100)
  const getSliderValue = (budget, modelId) => {
    if (modelId === 'gemini-2.5-pro') {
      // Range: 128-32768 tokens
      return Math.round(((budget - 128) / (32768 - 128)) * 100);
    } else if (modelId === 'gemini-2.5-flash') {
      // Range: 1-24576 tokens for Flash (start from 1 to avoid conflict with disabled)
      return Math.round(((budget - 1) / (24576 - 1)) * 100);
    } else {
      // Range: 512-24576 tokens for Flash Lite
      return Math.round(((budget - 512) / (24576 - 512)) * 100);
    }
  };

  // Helper function to convert slider value back to token count
  const getTokensFromSlider = (sliderValue, modelId) => {
    if (modelId === 'gemini-2.5-pro') {
      // Range: 128-32768 tokens
      return Math.round(128 + (sliderValue / 100) * (32768 - 128));
    } else if (modelId === 'gemini-2.5-flash') {
      // Range: 1-24576 tokens for Flash (start from 1 to avoid conflict with disabled)
      return Math.round(1 + (sliderValue / 100) * (24576 - 1));
    } else {
      // Range: 512-24576 tokens for Flash Lite
      return Math.round(512 + (sliderValue / 100) * (24576 - 512));
    }
  };

  // Handle dropdown mode change
  const handleModeChange = (modelId, mode) => {
    let newBudget;
    if (mode === 'dynamic') {
      newBudget = -1;
    } else if (mode === 'disabled') {
      newBudget = 0;
    } else if (mode === 'custom') {
      // Set to a reasonable default for custom mode
      if (modelId === 'gemini-2.5-pro') {
        newBudget = 1024;
      } else if (modelId === 'gemini-2.5-flash') {
        newBudget = 1024; // Flash can start from 0, but 1024 is a good default
      } else {
        newBudget = 512; // Flash Lite minimum is 512
      }
    }

    setThinkingBudgets(prev => ({
      ...prev,
      [modelId]: newBudget
    }));
  };

  // Handle slider change for custom mode
  const handleSliderChange = (modelId, sliderValue) => {
    const tokens = getTokensFromSlider(sliderValue, modelId);
    setThinkingBudgets(prev => ({
      ...prev,
      [modelId]: tokens
    }));
  };

  return (
    <div className="settings-section video-processing-section">

      {/* Grid layout for settings cards */}
      <div className="video-processing-grid">

        {/* Video Analysis Card - FIRST */}
        <div className="settings-card analysis-card">
          <div className="settings-card-header">
            <div className="settings-card-icon">
              <VideoAnalysisIcon />
            </div>
            <h4>{t('settings.videoAnalysisSection', 'Video Analysis')}</h4>
          </div>
          <div className="settings-card-content">
            <div className="compact-setting">
              <p className="setting-description">
                {t('settings.useVideoAnalysisDescription', 'Settings for the "Add analysis" button, which analyze the entire video with Gemini to identify the best prompt pattern and generate transcription rules.')}
              </p>
            </div>

            <div className="compact-setting">
              <label htmlFor="video-analysis-model">
                {t('settings.videoAnalysisModel', 'Analysis Model')}
              </label>
              <p className="setting-description">
                {t('settings.videoAnalysisModel.simplified', 'Select the model to use for video analysis. Flash Lite is faster but less accurate.')}
              </p>
              <CustomDropdown
                value={videoAnalysisModel}
                onChange={(value) => setVideoAnalysisModel(value)}
                options={getAnalysisModels().map((model) => ({
                  value: model.id,
                  label: model.name
                }))}
                placeholder={t('settings.selectAnalysisModel', 'Select Analysis Model')}
              />
            </div>

            <div className="compact-setting">
              <label htmlFor="video-analysis-timeout">
                {t('settings.videoAnalysisCountdown', 'Analysis Countdown Time')}
              </label>
              <p className="setting-description">
                {t('settings.videoAnalysisCountdownDesc', 'How long to wait before auto-saving analysis rules in autoflow mode.')}
              </p>
              <CustomDropdown
                value={videoAnalysisTimeout}
                onChange={(value) => setVideoAnalysisTimeout(value)}
                options={[
                  { value: 'none', label: t('settings.countdownNone', 'No countdown (trust the analysis, not recommended)') },
                  { value: '10', label: t('settings.countdown10', '10 seconds (default)') },
                  { value: '20', label: t('settings.countdown20', '20 seconds') },
                  { value: 'infinite', label: t('settings.countdownInfinite', 'Infinite countdown (no auto proceeding)') }
                ]}
                placeholder={t('settings.selectCountdownTime', 'Select Countdown Time')}
              />
            </div>
          </div>
        </div>

        {/* Processing Settings Card - SECOND */}
        <div className="settings-card processing-card">
          <div className="settings-card-header">
            <div className="settings-card-icon">
              <FiType />
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
              <div className="slider-with-value">
                <StandardSlider
                  value={favoriteMaxSubtitleLength}
                  onChange={(value) => setFavoriteMaxSubtitleLength(parseInt(value))}
                  min={1}
                  max={30}
                  step={1}
                  orientation="Horizontal"
                  size="Small"
                  state={showFavoriteMaxLength ? "Enabled" : "Disabled"}
                  showValueIndicator={false}
                  showIcon={false}
                  showStops={false}
                  className="max-subtitle-length-slider"
                  id="favorite-max-subtitle-length"
                  ariaLabel={t('settings.favoriteMaxSubtitleLength', 'Favorite max length of one subtitle')}
                  disabled={!showFavoriteMaxLength}
                />
                <div className="slider-value-display" style={{ opacity: showFavoriteMaxLength ? 1 : 0.5 }}>
                  {favoriteMaxSubtitleLength} {t('settings.words', 'words')}
                </div>
              </div>
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
              <FiDownload />
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
        <div className="settings-card thinking-card">
          <div className="settings-card-header">
            <div className="settings-card-icon">
              <svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor">
                <path d="M227-246q-58-54-89-124.5t-31-149.87Q107-675 215.5-784T480-893q128 0 228.5 77T839-618l52 206q6 25-9.82 45T839-347h-66v94q0 45-31.14 75.5T667-147h-54v27q0 22-15.5 37.5T560-67q-22 0-37.5-15.5T507-120v-80q0-22 15.5-37.5T560-253h107v-147q0-22 15.5-37.5T720-453h51l-34-138q-23-85-94.5-140.5T480-787q-110.61 0-188.81 77.5Q213-632 213-521.93q0 56.93 23 109.43 23 52.5 66 91.5l31 28v173q0 22-15.5 37.5T280-67q-22 0-37.5-15.5T227-120v-126Zm265-181Zm-22 139q22 0 36-14.38 14-14.37 14-35.62t-14.5-35.63Q491-388 469.82-388q-21.17 0-35.5 14.32Q420-359.35 420-338.18q0 21.18 14.38 35.68Q448.75-288 470-288Zm2.89-355q17.11 0 29.11 9.5t12 23.5q0 13-7.5 26T479-551q-21 23-31.5 42T433-467q-2 15.6 9.5 27.3Q454-428 471.33-428 486-428 498-439q12-11 17-28 3.75-12 11.88-23.5Q535-502 551-519q26-28 35.5-48t9.5-43q0-46.2-36-78.1-36-31.9-87-31.9-32 0-60.5 15T364-662q-11 14-6 31.5t22 24.5q14 6 27.5 1.5T434-623q7.78-9.6 17.89-14.8 10.11-5.2 21-5.2Z"/>
              </svg>
            </div>
            <h4>{t('settings.thinkingBudgetSection', 'AI Thinking Budget')}</h4>
          </div>
          <div className="settings-card-content">
            <p className="setting-description">
              {t('settings.thinkingBudgetDescription', 'Configure how much thinking each AI model should use. Higher budgets allow more detailed reasoning but increase processing time and cost.')}
            </p>

            {/* Gemini 2.5 Pro */}
            <div className="compact-setting">
              <label htmlFor="thinking-mode-25-pro">
                {t('settings.thinkingBudget25Pro', 'Gemini 2.5 Pro Thinking Budget')}
              </label>
              <p className="setting-description">
                {t('settings.thinkingBudget25ProDesc', 'Cannot disable thinking. Choose dynamic or set custom token budget.')}
              </p>
              <CustomDropdown
                value={getThinkingMode(thinkingBudgets['gemini-2.5-pro'] || 128)}
                onChange={(value) => handleModeChange('gemini-2.5-pro', value)}
                options={[
                  { value: 'dynamic', label: t('settings.thinkingDynamic', 'Dynamic (Auto)') },
                  { value: 'custom', label: `${t('settings.thinkingCustom', 'Custom')} (${t('settings.default', 'Default')})` }
                ]}
                placeholder={t('settings.selectThinkingMode', 'Select Thinking Mode')}
              />

              {getThinkingMode(thinkingBudgets['gemini-2.5-pro'] || 128) === 'custom' && (
                <div className="thinking-slider-container">
                  <div className="slider-with-value">
                    <StandardSlider
                      value={getSliderValue(thinkingBudgets['gemini-2.5-pro'], 'gemini-2.5-pro')}
                      onChange={(value) => handleSliderChange('gemini-2.5-pro', parseInt(value))}
                      min={0}
                      max={100}
                      step={1}
                      orientation="Horizontal"
                      size="XSmall"
                      state="Enabled"
                      showValueIndicator={false} // Using custom value display
                      showIcon={false}
                      showStops={false}
                      className="thinking-budget-slider"
                      id="thinking-budget-pro"
                      ariaLabel={t('settings.thinkingBudget', 'Thinking Budget')}
                    />
                    <div className="slider-value-display">
                      {thinkingBudgets['gemini-2.5-pro']} {t('settings.tokens', 'tokens')}
                    </div>
                  </div>
                  <div className="slider-range-info">
                    {t('settings.thinkingRange', 'Range')}: 128 - 32,768 {t('settings.tokens', 'tokens')}
                  </div>
                </div>
              )}
            </div>

            {/* Gemini 2.5 Flash */}
            <div className="compact-setting">
              <label htmlFor="thinking-mode-25-flash">
                {t('settings.thinkingBudget25Flash', 'Gemini 2.5 Flash Thinking Budget')}
              </label>
              <p className="setting-description">
                {t('settings.thinkingBudget25FlashDesc', 'Can be disabled for fastest response, dynamic for auto, or custom token budget.')}
              </p>
              <CustomDropdown
                value={getThinkingMode(thinkingBudgets['gemini-2.5-flash'] || 0)}
                onChange={(value) => handleModeChange('gemini-2.5-flash', value)}
                options={[
                  { value: 'disabled', label: `${t('settings.thinkingDisabled', 'Disabled')} (${t('settings.default', 'Default')})` },
                  { value: 'dynamic', label: t('settings.thinkingDynamic', 'Dynamic (Auto)') },
                  { value: 'custom', label: t('settings.thinkingCustom', 'Custom') }
                ]}
                placeholder={t('settings.selectThinkingMode', 'Select Thinking Mode')}
              />

              {getThinkingMode(thinkingBudgets['gemini-2.5-flash'] || 0) === 'custom' && (
                <div className="thinking-slider-container">
                  <div className="slider-with-value">
                    <StandardSlider
                      value={getSliderValue(thinkingBudgets['gemini-2.5-flash'], 'gemini-2.5-flash')}
                      onChange={(value) => handleSliderChange('gemini-2.5-flash', parseInt(value))}
                      min={0}
                      max={100}
                      step={1}
                      orientation="Horizontal"
                      size="XSmall"
                      state="Enabled"
                      showValueIndicator={false} // Using custom value display
                      showIcon={false}
                      showStops={false}
                      className="thinking-budget-slider"
                      id="thinking-budget-flash"
                      ariaLabel={t('settings.thinkingBudget', 'Thinking Budget')}
                    />
                    <div className="slider-value-display">
                      {thinkingBudgets['gemini-2.5-flash']} {t('settings.tokens', 'tokens')}
                    </div>
                  </div>
                  <div className="slider-range-info">
                    {t('settings.thinkingRange', 'Range')}: 1 - 24,576 {t('settings.tokens', 'tokens')}
                  </div>
                </div>
              )}
            </div>

            {/* Gemini 2.5 Flash Lite */}
            <div className="compact-setting">
              <label htmlFor="thinking-mode-25-flash-lite">
                {t('settings.thinkingBudget25FlashLite', 'Gemini 2.5 Flash Lite Thinking Budget')}
              </label>
              <p className="setting-description">
                {t('settings.thinkingBudget25FlashLiteDesc', 'Disabled by default for fastest response. Choose dynamic or custom token budget.')}
              </p>
              <CustomDropdown
                value={getThinkingMode(thinkingBudgets['gemini-2.5-flash-lite'] || 0)}
                onChange={(value) => handleModeChange('gemini-2.5-flash-lite', value)}
                options={[
                  { value: 'disabled', label: `${t('settings.thinkingDisabled', 'Disabled')} (${t('settings.default', 'Default')})` },
                  { value: 'dynamic', label: t('settings.thinkingDynamic', 'Dynamic (Auto)') },
                  { value: 'custom', label: t('settings.thinkingCustom', 'Custom') }
                ]}
                placeholder={t('settings.selectThinkingMode', 'Select Thinking Mode')}
              />

              {getThinkingMode(thinkingBudgets['gemini-2.5-flash-lite'] || 0) === 'custom' && (
                <div className="thinking-slider-container">
                  <div className="slider-with-value">
                    <StandardSlider
                      value={getSliderValue(thinkingBudgets['gemini-2.5-flash-lite'], 'gemini-2.5-flash-lite')}
                      onChange={(value) => handleSliderChange('gemini-2.5-flash-lite', parseInt(value))}
                      min={0}
                      max={100}
                      step={1}
                      orientation="Horizontal"
                      size="XSmall"
                      state="Enabled"
                      showValueIndicator={false} // Using custom value display
                      showIcon={false}
                      showStops={false}
                      className="thinking-budget-slider"
                      id="thinking-budget-lite"
                      ariaLabel={t('settings.thinkingBudget', 'Thinking Budget')}
                    />
                    <div className="slider-value-display">
                      {thinkingBudgets['gemini-2.5-flash-lite']} {t('settings.tokens', 'tokens')}
                    </div>
                  </div>
                  <div className="slider-range-info">
                    {t('settings.thinkingRange', 'Range')}: 512 - 24,576 {t('settings.tokens', 'tokens')}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

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
