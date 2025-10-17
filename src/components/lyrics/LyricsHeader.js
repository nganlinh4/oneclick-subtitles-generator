import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import SubtitleSplitModal from './SubtitleSplitModal';

const LyricsHeader = ({
  allowEditing,
  isSticky,
  setIsSticky,
  canUndo,
  canRedo,
  canJumpToCheckpoint,
  isAtOriginalState,
  isAtSavedState,
  onUndo,
  onRedo,
  onReset,
  onJumpToCheckpoint,
  onSave,
  autoScrollEnabled,
  setAutoScrollEnabled,
  lyrics,
  onSplitSubtitles,
  selectedRange = null
}) => {
  const { t } = useTranslation();
  const [showSplitModal, setShowSplitModal] = useState(false);
  
  // Check if there are subtitles in the selected range
  const hasSubtitlesInRange = () => {
    if (!selectedRange || !lyrics || lyrics.length === 0) return false;
    // Check if any subtitle is fully contained within the selected range
    return lyrics.some(lyric => 
      lyric.start >= selectedRange.start && 
      lyric.end <= selectedRange.end
    );
  };
  
  const canSplitSubtitles = selectedRange && hasSubtitlesInRange();

  // Global keyboard shortcuts for editor actions
  useEffect(() => {
    const shouldIgnore = (e) => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      const editable = el.isContentEditable;
      return editable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    };

    const onKeyDown = (e) => {
      if (!allowEditing) return;
      if (shouldIgnore(e)) return;

      // Normalize key
      const key = e.key.toLowerCase();
      const isCtrl = e.ctrlKey || e.metaKey; // support Cmd on macOS

      // Undo: Ctrl+Z
      if (isCtrl && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (canUndo && typeof onUndo === 'function') onUndo();
        return;
      }

      // Redo: Ctrl+Shift+Z or Ctrl+Y
      if ((isCtrl && key === 'y') || (isCtrl && key === 'z' && e.shiftKey)) {
        e.preventDefault();
        if (canRedo && typeof onRedo === 'function') onRedo();
        return;
      }

      // Save: Ctrl+S
      if (isCtrl && key === 's') {
        e.preventDefault();
        if (typeof onSave === 'function') onSave();
        return;
      }

      // Open Split modal: Ctrl+Shift+X (only if range is selected)
      if (isCtrl && e.shiftKey && key === 'x') {
        e.preventDefault();
        if (canSplitSubtitles) {
          setShowSplitModal(true);
        }
        return;
      }

      // Jump to checkpoint: Ctrl+J
      if (isCtrl && key === 'j') {
        e.preventDefault();
        if (canJumpToCheckpoint && typeof onJumpToCheckpoint === 'function') onJumpToCheckpoint();
        return;
      }

      // Toggle sticky timings: Ctrl+Shift+T
      if (isCtrl && e.shiftKey && key === 't') {
        e.preventDefault();
        if (typeof setIsSticky === 'function') setIsSticky(!isSticky);
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [allowEditing, canUndo, canRedo, canJumpToCheckpoint, onUndo, onRedo, onSave, onJumpToCheckpoint, setIsSticky, isSticky, canSplitSubtitles]);

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
            <span className="material-symbols-rounded auto-scroll-icon" style={{ fontSize: 16, display: 'inline-block' }}>
              move_selection_down
            </span>
          ) : (
            <span className="material-symbols-rounded auto-scroll-icon" style={{ fontSize: 16, display: 'inline-block' }}>
              mobiledata_off
            </span>
          )}
          <span>{t('lyrics.autoScroll', 'Cuộn')}</span>
        </div>

        {allowEditing && (
          <div
            className={`sticky-toggle ${isSticky ? 'active' : ''}`}
            onClick={() => setIsSticky(!isSticky)}
            title={t('lyrics.stickyTimingsToggleWithShortcut', isSticky ? 'Disable sticky timings (Ctrl+Shift+T)' : 'Enable sticky timings (Ctrl+Shift+T)')}
          >
            {isSticky ? (
              <span className="material-symbols-rounded sticky-icon" style={{ fontSize: 16, display: 'inline-block' }}>
                link
              </span>
            ) : (
              <span className="material-symbols-rounded sticky-icon" style={{ fontSize: 16, display: 'inline-block' }}>
                link_off
              </span>
            )}
            <span>{t('lyrics.stickyTimingsToggle', 'Dính')}</span>
          </div>
        )}
      </div>

      {/* Second row for save and reset buttons */}
      <div className="controls-middle-row">
        {allowEditing && (
          <div className="middle-row-buttons">
            <button
              className="split-sub-btn"
              onClick={() => setShowSplitModal(true)}
              disabled={!canSplitSubtitles}
              title={canSplitSubtitles 
                ? t('lyrics.splitWithShortcut', 'Split subtitles in selected range (Ctrl+Shift+X)')
                : t('lyrics.splitDisabled', 'Select a range with subtitles to split')
              }
              style={{
                opacity: canSplitSubtitles ? 1 : 0.4,
                cursor: canSplitSubtitles ? 'pointer' : 'not-allowed'
              }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
                {/* Left rectangle (before cut) */}
                <path d="M2 8L8 8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 16L8 16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 8L2 16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>

                {/* Right rectangle (after cut) */}
                <path d="M16 8L22 8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M16 16L22 16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M22 8L22 16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>

                {/* Vertical cutting line (knife) */}
                <path d="M12 4L12 20" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>

            <button
              className="lyrics-save-btn"
              onClick={onSave}
              disabled={isAtSavedState}
              title={isAtSavedState ? t('common.saveDisabled', 'No changes to save') : t('common.saveWithShortcut', 'Save (Ctrl+S)')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16, display: 'inline-block' }}>
                save
              </span>
            </button>

            <button
              className="reset-btn"
              onClick={onReset}
              disabled={isAtSavedState}
              title={t('common.resetWithShortcut', 'Reset to saved state')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16, display: 'inline-block' }}>
                refresh
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Third row for undo and redo buttons */}
      <div className="controls-bottom-row">
        {allowEditing && (
          <div className="bottom-row-buttons">
            <button
              className="checkpoint-btn"
              onClick={onJumpToCheckpoint}
              disabled={!canJumpToCheckpoint}
              title={t('common.jumpToCheckpointWithShortcut', 'Jump to last checkpoint (Ctrl+J)')}
            >
              {/* Flag with curved arrow icon - active */}
              {/* Flag with curved arrow icon - active */}
              <span className="material-symbols-rounded" style={{ fontSize: 16, display: 'inline-block' }}>
                flag
              </span>
              {/* Clock with reverse arrow icon - alternative (commented out) */}
              {/* <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>schedule</span> */}
            </button>
            
            <button
              className="undo-btn"
              onClick={onUndo}
              disabled={!canUndo}
              title={t('common.undoWithShortcut', 'Undo (Ctrl+Z)')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16, display: 'inline-block' }}>
                undo
              </span>
            </button>

            <button
              className="redo-btn"
              onClick={onRedo}
              disabled={!canRedo}
              title={t('common.redoWithShortcut', 'Redo (Ctrl+Y or Ctrl+Shift+Z)')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16, display: 'inline-block' }}>
                redo
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Subtitle Split Modal */}
      <SubtitleSplitModal
        isOpen={showSplitModal}
        onClose={() => setShowSplitModal(false)}
        lyrics={lyrics}
        onSplitSubtitles={onSplitSubtitles}
        selectedRange={selectedRange}
      />
    </div>
  );
};

export default LyricsHeader;