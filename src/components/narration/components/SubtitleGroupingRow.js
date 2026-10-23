// Subtitle grouping row of the narration source panel: intensity dropdown, grouping switch and the
// grouped-sentence summary with its comparison button.
import { useTranslation } from 'react-i18next';
import MaterialSwitch from '../../common/MaterialSwitch';
import CustomDropdown from '../../common/CustomDropdown';
import HelpIcon from '../../common/HelpIcon';

const SubtitleGroupingRow = ({
  subtitleSource,
  isGenerating,
  hasSubtitles,
  originalSubtitles,
  groupedSubtitles,
  useGroupedSubtitles,
  isGroupingSubtitles,
  groupingIntensity,
  setGroupingIntensity,
  handleGroupingToggle,
  openModal,
}) => {
  const { t } = useTranslation();
  return (
    <div className="narration-row subtitle-grouping-row animated-row">
      <div className="row-label">
        <label>{t('narration.subtitleGrouping', 'Subtitle Grouping')}:</label>
      </div>
      <div className="row-content">
        <div className="subtitle-grouping-container" style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: '20px' }}>
          {/* Grouping Intensity Dropdown */}
          <div
            className="grouping-intensity-container"
          >
            <label htmlFor="grouping-intensity" className="grouping-intensity-label">
              {t('narration.groupingIntensity', 'Grouping Intensity')}:
            </label>
            <CustomDropdown
              value={groupingIntensity}
              onChange={(value) => setGroupingIntensity(value)}
              disabled={isGenerating || !subtitleSource || isGroupingSubtitles || !hasSubtitles || useGroupedSubtitles}
              options={[
                { value: 'minimal', label: t('narration.intensityMinimal', 'Minimal') },
                { value: 'light', label: t('narration.intensityLight', 'Light') },
                { value: 'balanced', label: t('narration.intensityBalanced', 'Balanced') },
                { value: 'moderate', label: t('narration.intensityModerate', 'Moderate') },
                { value: 'enhanced', label: t('narration.intensityEnhanced', 'Enhanced') },
                { value: 'aggressive', label: t('narration.intensityAggressive', 'Aggressive') }
              ]}
              placeholder={t('narration.selectIntensity', 'Select Intensity')}
            />
          </div>

          {/* Material Web Switch and Grouping Info */}
          <div className="grouping-controls-wrapper" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="material-switch-container">
              <MaterialSwitch
                id="subtitle-grouping"
                checked={useGroupedSubtitles}
                onChange={(e) => handleGroupingToggle(e.target.checked)}
                disabled={isGenerating || !subtitleSource || isGroupingSubtitles || !hasSubtitles}
                ariaLabel={t('narration.groupSubtitlesShort', 'Group subtitles')}
                icons={true}
              />
              <label htmlFor="subtitle-grouping" className="material-switch-label">
                <HelpIcon title={t('narration.groupSubtitles', 'Smartly group subtitles into fuller sentences for narration')} />
                {isGroupingSubtitles && (
                  <span className="loading-animation" style={{ marginLeft: '10px', display: 'inline-flex', alignItems: 'center' }}>
                    <span className="spinner-circle" style={{ width: '14px', height: '14px' }}></span>
                    <span style={{ marginLeft: '5px' }}>{t('narration.groupingSubtitles', 'Grouping...')}</span>
                  </span>
                )}
              </label>
            </div>

            {/* Show comparison button when grouped subtitles are available */}
            {useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0 && (
              <div className="grouping-info-container">
                <button
                  className="pill-button view-grouping-button"
                  onClick={openModal}
                >
                  <span className="material-symbols-rounded info-icon" style={{ fontSize: '16px' }}>info</span>
                  {t('narration.viewGrouping', 'View Grouping')}
                </button>
                <span className="grouping-stats">
                  {t('narration.groupedSubtitlesCount', 'Grouped {{original}} subtitles into {{grouped}} sentences', {
                    original: originalSubtitles?.length || 0,
                    grouped: groupedSubtitles?.length || 0
                  })}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SubtitleGroupingRow;
