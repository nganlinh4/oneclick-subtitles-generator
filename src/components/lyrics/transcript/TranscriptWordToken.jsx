import { useTranslation } from 'react-i18next';

const formatTimestamp = (ms) => {
  if (!Number.isFinite(ms)) return '00:00.000';
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(3);
  return `${String(minutes).padStart(2, '0')}:${seconds.padStart(6, '0')}`;
};

/**
 * Clickable word token in the Transcript surface.
 * Clicking seeks the media player to exact word.start_ms / 1000.
 * Highlights in real-time as the media plays.
 */
export const TranscriptWordToken = ({
  word,
  isActive = false,
  onWordClick,
  onWordEdit,
}) => {
  const { t } = useTranslation();

  const isModified = word.provenance === 'Manual' || word.alignment_status === 'Modified';
  const isUnaligned = Boolean(word.is_unaligned) || word.alignment_status === 'Unaligned';

  const handleClick = (e) => {
    e.stopPropagation();
    if (onWordClick && Number.isFinite(word.start_ms)) {
      onWordClick(word.start_ms / 1000);
    }
  };

  const handleDoubleClick = (e) => {
    e.stopPropagation();
    onWordEdit?.(word);
  };

  const tooltipText = `${formatTimestamp(word.start_ms)} – ${formatTimestamp(word.end_ms)} (${Math.max(0, word.end_ms - word.start_ms)}ms)${
    word.speaker_id ? ` • ${word.speaker_id}` : ''
  }${isUnaligned ? ' • ⚠ Unaligned' : isModified ? ' • Modified' : ''}`;

  return (
    <span
      className={`transcript-word-token ${isActive ? 'active' : ''} ${
        isModified ? 'provenance-modified' : ''
      } ${isUnaligned ? 'provenance-unaligned' : ''}`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      title={tooltipText}
      data-word-id={word.id}
      data-start-ms={word.start_ms}
      data-end-ms={word.end_ms}
      data-testid={`word-token-${word.id}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick(e);
        }
      }}
    >
      <span className="word-token-text">{word.text}</span>
      {isUnaligned && (
        <span className="unaligned-indicator" aria-label={t('transcript.unalignedTiming', 'Unaligned timing')}>
          ⚠
        </span>
      )}
    </span>
  );
};

export default TranscriptWordToken;
