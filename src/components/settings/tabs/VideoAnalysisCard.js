import { useTranslation } from 'react-i18next';
import { ANALYSIS_MODEL_IDS, getModelById } from '../../../config/geminiModels';
import { VideoAnalysisIcon } from '../icons/TabIcons';
import CustomDropdown from '../../common/CustomDropdown';

const VideoAnalysisCard = ({
  videoAnalysisModel,
  setVideoAnalysisModel,
  videoAnalysisTimeout,
  setVideoAnalysisTimeout
}) => {
  const { t } = useTranslation();

  // Helper function to get analysis models (subset of all models)
  const getAnalysisModels = () => {
    const builtInAnalysisModels = ANALYSIS_MODEL_IDS.map(id => {
      const m = getModelById(id);
      return {
        id: m.id,
        name: `${t(m.nameKey, m.nameDefault)} (${t('models.dailyQuota', '{{count}} requests/day', { count: m.freeRPD })})`
      };
    });

    return builtInAnalysisModels;
  };

  return (
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
            {t('settings.videoAnalysisModel.simplified', 'Only catalog-verified models that accept video input are listed.')}
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
  );
};

export default VideoAnalysisCard;
