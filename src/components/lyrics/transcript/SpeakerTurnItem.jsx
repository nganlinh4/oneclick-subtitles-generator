import { useTranslation } from 'react-i18next';
import { getSpeakerPalette, getSpeakerMonogram } from './SpeakerColorPalette';
import SpeakerNameInput from './SpeakerNameInput';
import TranscriptWordToken from './TranscriptWordToken';

const formatTimeRange = (startMs, endMs) => {
  const format = (ms) => {
    if (!Number.isFinite(ms)) return '00:00';
    const totalSec = ms / 1000;
    const min = Math.floor(totalSec / 60);
    const sec = Math.floor(totalSec % 60);
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };
  return `${format(startMs)} – ${format(endMs)}`;
};

/**
 * SpeakerTurnItem represents a conversational turn in the Transcript Surface.
 * Houses speaker avatar, name, timing metadata, and a flow of clickable word tokens.
 */
export const SpeakerTurnItem = ({
  turn,
  words = [],
  currentTimeMs = 0,
  onWordClick,
  onWordEdit,
  onSpeakerRename,
  speakerNames = {},
}) => {
  const { t } = useTranslation();
  const speakerId = turn.speakerId || turn.speaker_id || 'unknown';
  const displayName = speakerNames[speakerId] || speakerId;
  const palette = getSpeakerPalette(speakerId);
  const monogram = getSpeakerMonogram(displayName);

  const turnStartMs = turn.startMs ?? turn.start_ms ?? (Number.isFinite(turn.start) ? Math.round(turn.start * 1000) : (words[0]?.startMs ?? words[0]?.start_ms ?? (Number.isFinite(words[0]?.start) ? Math.round(words[0].start * 1000) : 0)));
  const turnEndMs = turn.endMs ?? turn.end_ms ?? (Number.isFinite(turn.end) ? Math.round(turn.end * 1000) : (words[words.length - 1]?.endMs ?? words[words.length - 1]?.end_ms ?? (Number.isFinite(words[words.length - 1]?.end) ? Math.round(words[words.length - 1].end * 1000) : 0)));
  const isTurnActive = currentTimeMs >= turnStartMs && currentTimeMs <= turnEndMs;

  const handlePlayTurn = (e) => {
    e.stopPropagation();
    if (onWordClick && Number.isFinite(turnStartMs)) {
      onWordClick(turnStartMs / 1000);
    }
  };

  return (
    <div
      className={`speaker-turn-item ${isTurnActive ? 'turn-active' : ''}`}
      style={{
        '--turn-speaker-color': palette.bg,
        '--turn-speaker-container': palette.container,
      }}
      data-testid={`speaker-turn-${turn.id || turn.turn_id || speakerId || 'item'}`}
    >
      <div className="speaker-turn-header">
        <div
          className="speaker-avatar"
          style={{ backgroundColor: palette.bg, color: palette.text }}
          aria-hidden="true"
        >
          {monogram}
        </div>

        <div className="speaker-identity-lane">
          <SpeakerNameInput
            speakerId={speakerId}
            displayName={displayName}
            onSpeakerRename={onSpeakerRename}
            palette={palette}
          />
          <span className="speaker-turn-time">
            {formatTimeRange(turnStartMs, turnEndMs)}
          </span>
        </div>

        <button
          type="button"
          className="play-turn-btn"
          onClick={handlePlayTurn}
          title={t('transcript.playTurn', 'Play from start of turn')}
          aria-label={t('transcript.playTurn', 'Play from start of turn')}
          data-testid="play-turn-btn"
        >
          <span className="material-symbols-rounded" style={{ fontSize: '18px' }}>
            play_arrow
          </span>
        </button>
      </div>

      <div className="speaker-turn-words">
        {words.map((word) => {
          const wStart = word.startMs ?? word.start_ms ?? (Number.isFinite(word.start) ? Math.round(word.start * 1000) : 0);
          const wEnd = word.endMs ?? word.end_ms ?? (Number.isFinite(word.end) ? Math.round(word.end * 1000) : 0);
          const isActive =
            currentTimeMs >= wStart && currentTimeMs < wEnd;
          return (
            <TranscriptWordToken
              key={word.id}
              word={word}
              isActive={isActive}
              onWordClick={onWordClick}
              onWordEdit={onWordEdit}
            />
          );
        })}
      </div>
    </div>
  );
};

export default SpeakerTurnItem;
