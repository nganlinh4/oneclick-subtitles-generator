import React, { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from '../../common/SliderWithValue';
import CloseButton from '../../common/CloseButton';
import { showWarningToast } from '../../../utils/toastUtils';

/**
 * Narration Menu component
 *
 * @param {Object} props - Component props
 * @param {boolean} props.showNarrationMenu - Whether to show the narration menu
 * @param {Function} props.setShowNarrationMenu - Function to set showNarrationMenu state
 * @param {string} props.narrationSource - Current narration source
 * @param {Function} props.setNarrationSource - Function to set narrationSource state
 * @param {number} props.narrationVolume - Current narration volume
 * @param {Function} props.setNarrationVolume - Function to set narrationVolume state
 * @param {number} props.videoVolume - Current video volume
 * @param {Function} props.setVideoVolume - Function to set videoVolume state
 * @param {Object} props.currentNarration - Current playing narration
 * @param {boolean} props.hasOriginalNarrations - Whether original narrations are available
 * @param {boolean} props.hasTranslatedNarrations - Whether translated narrations are available
 * @param {boolean} props.hasAnyNarrations - Whether any narrations are available
 * @param {boolean} props.isSubtitleSettingsOpen - Whether subtitle settings panel is open
 * @param {Function} props.setIsSubtitleSettingsOpen - Function to set isSubtitleSettingsOpen state
 * @returns {JSX.Element} - Rendered component
 */
const NarrationMenu = ({
  showNarrationMenu,
  setShowNarrationMenu,
  narrationSource,
  setNarrationSource,
  narrationVolume,
  setNarrationVolume,
  videoVolume,
  setVideoVolume,
  currentNarration,
  hasOriginalNarrations,
  hasTranslatedNarrations,
  hasAnyNarrations,
  // Aligned narration props (some are unused now that it's always enabled)
  isGeneratingAligned,
  alignedStatus,
  // We need to access the subtitle settings state to close it when opening narration menu
  isSubtitleSettingsOpen,
  setIsSubtitleSettingsOpen
}) => {
  const { t } = useTranslation();
  const menuRef = useRef(null);

  // Show warning toast when menu opens and no narrations are available
  useEffect(() => {
    if (showNarrationMenu && !hasAnyNarrations) {
      showWarningToast(t('narration.noNarrationsAvailable', 'No narrations available. Generate narration first.'));
    }
  }, [showNarrationMenu, hasAnyNarrations, t]);

  // Add escape key and click outside handlers to close the menu
  useEffect(() => {
    // Handle escape key
    const handleEscKey = (event) => {
      if (event.key === 'Escape' && showNarrationMenu) {
        setShowNarrationMenu(false);
      }
    };

    // Handle click outside
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target) && showNarrationMenu) {
        setShowNarrationMenu(false);
      }
    };

    document.addEventListener('keydown', handleEscKey);
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('keydown', handleEscKey);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showNarrationMenu, setShowNarrationMenu]);

  return (
    <div ref={menuRef} className="narration-menu-container">
      <button
        className={`action-button narration-settings-toggle md-filled-tonal-button ${showNarrationMenu ? 'active' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          const newShowNarrationMenu = !showNarrationMenu;
          setShowNarrationMenu(newShowNarrationMenu);

          // Close subtitle settings if opening narration menu
          if (newShowNarrationMenu && isSubtitleSettingsOpen) {

            setIsSubtitleSettingsOpen(false);
          }


        }}
        title={t('narration.settingsTooltip', 'Narration Settings')}
      >
        <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>record_voice_over</span>
        <span>{t('narration.toggleSettings', 'Narration Settings')}</span>
      </button>

      {/* Narration menu panel with subtitle-settings styling */}
      {showNarrationMenu && (
        <div
          className="subtitle-settings-panel narration-panel"
          style={{ position: 'absolute', top: 'calc(125%)', right: '-5px', width: '320px', zIndex: 9999 }}
          onClick={(e) => e.stopPropagation()}
        >

          <div className="settings-content">

            {/* Volume Controls */}
            <div className="setting-group">
              <label className={hasAnyNarrations ? '' : 'disabled'}>
                <span className="icon-label-container">
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>voice_selection</span>
                  <span>
                    {t('narration.narrationVolume', 'Narration Volume')}
                    {currentNarration && (
                      <span className="narration-status-indicator">
                        <span className="status-dot"></span>
                        {t('narration.playing', 'Playing')}
                      </span>
                    )}
                  </span>
                </span>
              </label>
              <SliderWithValue
                value={narrationVolume}
                onChange={(value) => {
                  const newVolume = parseFloat(value);
                  setNarrationVolume(newVolume);
                  window.dispatchEvent(new CustomEvent('narration-volume-change', { detail: { volume: newVolume } }));
                }}
                min={0}
                max={1}
                step={0.01}
                orientation="Horizontal"
                size="XSmall"
                state={hasAnyNarrations ? "Enabled" : "Disabled"}
                className="narration-volume-slider"
                id="narration-volume"
                ariaLabel={t('narration.narrationVolume', 'Narration Volume')}
                formatValue={(v) => `${Math.round(Number(v) * 100)}%`}
              />
            </div>

            {/* Aligned narration status */}
            {hasAnyNarrations && isGeneratingAligned && (
              <div className="setting-group">
                <div className="notification-message info">
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>info</span>
                  <span>
                    {alignedStatus?.message || t('narration.generatingAligned', 'Generating aligned narration...')}
                  </span>
                </div>
              </div>
            )}

            <div className="setting-group">
              <label>
                <span className="icon-label-container">
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>volume_up</span>
                  <span>{t('narration.videoVolume', 'Video Audio Volume')}</span>
                </span>
              </label>
              <SliderWithValue
                value={videoVolume}
                onChange={(value) => {
                  const newVolume = parseFloat(value);
                  setVideoVolume(newVolume);
                  window.dispatchEvent(new CustomEvent('video-volume-change', { detail: { volume: newVolume } }));
                }}
                min={0}
                max={1}
                step={0.01}
                orientation="Horizontal"
                size="XSmall"
                state="Enabled"
                className="video-volume-slider"
                id="video-volume"
                ariaLabel={t('narration.videoVolume', 'Video Audio Volume')}
                formatValue={(v) => `${Math.round(Number(v) * 100)}%`}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NarrationMenu;
