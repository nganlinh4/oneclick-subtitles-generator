import React from 'react';
import { useTranslation } from 'react-i18next';

const LyricsHeader = ({
  allowEditing,
  isSticky,
  setIsSticky,
  canUndo,
  canRedo,
  isAtOriginalState,
  isAtSavedState,
  onUndo,
  onRedo,
  onReset,
  onSave,
  autoScrollEnabled,
  setAutoScrollEnabled
}) => {
  const { t } = useTranslation();

  return (
    <div className="combined-controls">
      {/* First row for auto-scroll and sticky toggle */}
      <div className="controls-top-row">
        {/* Auto-scroll toggle switch */}
        <div
          className={`auto-scroll-toggle ${autoScrollEnabled ? 'active' : ''}`}
          onClick={() => setAutoScrollEnabled(!autoScrollEnabled)}
          title={autoScrollEnabled ? t('lyrics.autoScrollDisable', 'Disable auto-scroll') : t('lyrics.autoScrollEnable', 'Enable auto-scroll')}
        >
          {autoScrollEnabled ? (
            <svg className="auto-scroll-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2.5" fill="none">
              <path d="M12 2v20"/>
              <path d="m19 15-7 7-7-7"/>
              <path d="m19 9-7-7-7 7"/>
            </svg>
          ) : (
            <svg className="auto-scroll-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2.5" fill="none">
              <path d="M9 9h6v6h-6z"/>
              <path d="M21 3H3v18h18V3z"/>
            </svg>
          )}
          <span>{t('lyrics.autoScroll', 'Auto')}</span>
        </div>

        {allowEditing && (
          <div
            className={`sticky-toggle ${isSticky ? 'active' : ''}`}
            onClick={() => setIsSticky(!isSticky)}
            title={t('lyrics.stickyTimingsToggle', isSticky ? 'Disable sticky timings' : 'Enable sticky timings')}
          >
            {isSticky ? (
              <svg className="sticky-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2.5" fill="none">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
            ) : (
              <svg className="sticky-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2.5" fill="none">
                <path d="M6 8a4 4 0 0 1 0 8 4 4 0 0 1 0-8"/>
                <path d="M18 8a4 4 0 0 0 0 8 4 4 0 0 0 0-8"/>
              </svg>
            )}
            <span>{t('lyrics.stickyTimingsToggle', 'Stick')}</span>
          </div>
        )}
      </div>

      {/* Second row for save and reset buttons */}
      <div className="controls-middle-row">
        {allowEditing && (
          <div className="middle-row-buttons">
            <button
              className="lyrics-save-btn"
              onClick={onSave}
              title={t('common.save', 'Save progress')}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
                <polyline points="7 3 7 8 15 8"/>
              </svg>
            </button>

            <button
              className="reset-btn"
              onClick={onReset}
              disabled={isAtSavedState}
              title={t('common.reset', 'Reset to saved state')}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none" preserveAspectRatio="xMidYMid meet">
                <path d="M23 4v6h-6"/>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Third row for undo and redo buttons */}
      <div className="controls-bottom-row">
        {allowEditing && (
          <div className="bottom-row-buttons">
            <button
              className="undo-btn"
              onClick={onUndo}
              disabled={!canUndo}
              title={t('common.undo', 'Undo')}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
                <path d="M3 10h10c4.42 0 8 3.58 8 8v2M3 10l6-6M3 10l6 6"/>
              </svg>
            </button>

            <button
              className="redo-btn"
              onClick={onRedo}
              disabled={!canRedo}
              title={t('common.redo', 'Redo')}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
                <path d="M21 10h-10c-4.42 0-8 3.58-8 8v2M21 10l-6-6M21 10l-6 6"/>
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default LyricsHeader;