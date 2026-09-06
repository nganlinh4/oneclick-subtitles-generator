import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Compact Viewport Switcher (F15)
 * Segmented toggle in editor header between continuous Transcript view and discrete Captions view.
 * Strictly adheres to Material Design 3 tokens and ARIA tablist semantics.
 */
export const ViewportSwitcher = ({
  activeViewport = 'captions',
  onViewportChange,
  turnCount = 0,
  cueCount = 0,
}) => {
  const { t } = useTranslation();
  const transcriptBtnRef = useRef(null);
  const captionsBtnRef = useRef(null);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const targetMode = activeViewport === 'transcript' ? 'captions' : 'transcript';
      onViewportChange?.(targetMode);
      if (targetMode === 'transcript') {
        transcriptBtnRef.current?.focus();
      } else {
        captionsBtnRef.current?.focus();
      }
    } else if (e.key === 'Home') {
      e.preventDefault();
      onViewportChange?.('transcript');
      transcriptBtnRef.current?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      onViewportChange?.('captions');
      captionsBtnRef.current?.focus();
    }
  };

  return (
    <div
      className="viewport-segmented-control"
      role="tablist"
      aria-label={t('editor.viewportControl', 'Editor Viewport')}
      onKeyDown={handleKeyDown}
      data-testid="viewport-switcher"
    >
      <button
        ref={transcriptBtnRef}
        type="button"
        role="tab"
        tabIndex={activeViewport === 'transcript' ? 0 : -1}
        aria-selected={activeViewport === 'transcript'}
        aria-controls="transcript-surface-panel"
        className={`viewport-tab-button ${activeViewport === 'transcript' ? 'active' : ''}`}
        onClick={() => onViewportChange?.('transcript')}
        data-testid="viewport-tab-transcript"
      >
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: '18px' }}>
          record_voice_over
        </span>
        <span className="viewport-tab-label">{t('editor.viewportTranscript', 'Transcript')}</span>
        {turnCount > 0 && (
          <span className="viewport-tab-badge" data-testid="transcript-badge">
            {turnCount}
          </span>
        )}
      </button>

      <button
        ref={captionsBtnRef}
        type="button"
        role="tab"
        tabIndex={activeViewport === 'captions' ? 0 : -1}
        aria-selected={activeViewport === 'captions'}
        aria-controls="captions-surface-panel"
        className={`viewport-tab-button ${activeViewport === 'captions' ? 'active' : ''}`}
        onClick={() => onViewportChange?.('captions')}
        data-testid="viewport-tab-captions"
      >
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: '18px' }}>
          subtitles
        </span>
        <span className="viewport-tab-label">{t('editor.viewportCaptions', 'Captions')}</span>
        {cueCount > 0 && (
          <span className="viewport-tab-badge" data-testid="captions-badge">
            {cueCount}
          </span>
        )}
      </button>
    </div>
  );
};

export default ViewportSwitcher;
