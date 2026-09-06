import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import SpeakerTurnItem from './SpeakerTurnItem';

/**
 * Group words into speaker turns if explicit turns are not provided.
 */
function deriveTurnsFromWords(words) {
  if (!Array.isArray(words) || words.length === 0) return [];
  const sortedWords = [...words].sort((a, b) => {
    const startA = a.startMs ?? a.start_ms ?? Math.round((a.start || 0) * 1000);
    const startB = b.startMs ?? b.start_ms ?? Math.round((b.start || 0) * 1000);
    return startA - startB;
  });
  const turns = [];
  let currentTurn = null;

  for (const w of sortedWords) {
    const speakerId = w.speakerId || w.speaker_id || 'speaker_0';
    const startMs = w.startMs ?? w.start_ms ?? Math.round((w.start || 0) * 1000);
    const endMs = w.endMs ?? w.end_ms ?? Math.round((w.end || 0) * 1000);
    if (!currentTurn || (currentTurn.speakerId || currentTurn.speaker_id) !== speakerId) {
      currentTurn = {
        id: `turn_${turns.length + 1}`,
        turn_id: `turn_${turns.length + 1}`,
        speakerId,
        speaker_id: speakerId,
        startMs,
        start_ms: startMs,
        endMs,
        end_ms: endMs,
        word_ids: [w.id],
        wordIds: [w.id],
      };
      turns.push(currentTurn);
    } else {
      currentTurn.word_ids.push(w.id);
      currentTurn.wordIds.push(w.id);
      currentTurn.endMs = Math.max(currentTurn.endMs, endMs);
      currentTurn.end_ms = currentTurn.endMs;
    }
  }
  return turns;
}

/**
 * TranscriptSurface Component (F16)
 * Displays continuous transcript with speaker turns, visual avatars,
 * editable names, clickable word tokens, real-time active word tracking,
 * and follow-playback auto-suspension during user scroll.
 */
export const TranscriptSurface = ({
  turns = [],
  words = [],
  currentTime = 0,
  followPlayback = true,
  onWordClick,
  onWordEdit,
  onSpeakerRename,
  speakerNames = {},
}) => {
  const { t } = useTranslation();
  const containerRef = useRef(null);
  const activeItemRef = useRef(null);

  const [isFollowSuspended, setIsFollowSuspended] = useState(false);

  const currentTimeMs = Math.round((Number(currentTime) || 0) * 1000);

  // Map words by ID for fast lookup
  const wordsById = useMemo(() => {
    const map = new Map();
    for (const w of words) {
      map.set(w.id, w);
    }
    return map;
  }, [words]);

  // Derive turns if empty
  const displayTurns = useMemo(() => {
    if (Array.isArray(turns) && turns.length > 0) {
      return turns;
    }
    return deriveTurnsFromWords(words);
  }, [turns, words]);

  // Locate active turn index
  const activeTurnIndex = useMemo(() => {
    return displayTurns.findIndex((turn) => {
      const start = turn.startMs ?? turn.start_ms ?? (Number.isFinite(turn.start) ? Math.round(turn.start * 1000) : 0);
      const end = turn.endMs ?? turn.end_ms ?? (Number.isFinite(turn.end) ? Math.round(turn.end * 1000) : 0);
      return currentTimeMs >= start && currentTimeMs <= end;
    });
  }, [displayTurns, currentTimeMs]);

  // Smooth scroll to active turn when followPlayback is enabled and not suspended
  useEffect(() => {
    if (followPlayback && !isFollowSuspended && typeof activeItemRef.current?.scrollIntoView === 'function') {
      activeItemRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [activeTurnIndex, followPlayback, isFollowSuspended]);

  // Detect user manual scroll interaction to suspend auto-follow
  const handleScrollInteraction = useCallback(() => {
    if (followPlayback && !isFollowSuspended) {
      setIsFollowSuspended(true);
    }
  }, [followPlayback, isFollowSuspended]);

  const handleResumeFollow = () => {
    setIsFollowSuspended(false);
    if (typeof activeItemRef.current?.scrollIntoView === 'function') {
      activeItemRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  };

  if (words.length === 0 && displayTurns.length === 0) {
    return (
      <div className="transcript-empty-state" data-testid="transcript-empty-state">
        <span className="material-symbols-rounded empty-icon">record_voice_over</span>
        <p className="empty-title">
          {t('transcript.noSpokenWords', 'No spoken transcript available')}
        </p>
        <p className="empty-subtitle">
          {t('transcript.transcribePrompt', 'Transcribe speech to view turns, speakers, and timed words.')}
        </p>
      </div>
    );
  }

  return (
    <div
      className="transcript-surface-wrapper"
      data-testid="transcript-surface"
      onWheel={handleScrollInteraction}
      onTouchMove={handleScrollInteraction}
    >
      <div className="transcript-turns-container" ref={containerRef}>
        {displayTurns.map((turn, index) => {
          const isActive = index === activeTurnIndex;
          const turnStart = turn.startMs ?? turn.start_ms ?? (Number.isFinite(turn.start) ? Math.round(turn.start * 1000) : 0);
          const turnEnd = turn.endMs ?? turn.end_ms ?? (Number.isFinite(turn.end) ? Math.round(turn.end * 1000) : 0);
          const turnWordIds = turn.wordIds || turn.word_ids;
          const turnWords = Array.isArray(turnWordIds)
            ? turnWordIds.map((id) => wordsById.get(id)).filter(Boolean)
            : Array.isArray(turn.words)
            ? turn.words
            : words.filter((w) => {
                const wStart = w.startMs ?? w.start_ms ?? Math.round((w.start || 0) * 1000);
                const wEnd = w.endMs ?? w.end_ms ?? Math.round((w.end || 0) * 1000);
                return wStart >= turnStart && wEnd <= turnEnd;
              });

          return (
            <div
              key={turn.id || turn.turn_id || index}
              ref={isActive ? activeItemRef : null}
              className="speaker-turn-row-wrapper"
            >
              <SpeakerTurnItem
                turn={turn}
                words={turnWords}
                currentTimeMs={currentTimeMs}
                onWordClick={onWordClick}
                onWordEdit={onWordEdit}
                onSpeakerRename={onSpeakerRename}
                speakerNames={speakerNames}
              />
            </div>
          );
        })}
      </div>

      {isFollowSuspended && (
        <div className="transcript-follow-suspended-banner">
          <button
            type="button"
            className="resume-follow-chip"
            onClick={handleResumeFollow}
            data-testid="resume-follow-btn"
          >
            <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>
              arrow_downward
            </span>
            <span>
              {t('transcript.resumeFollow', 'Playback at {{time}} • Resume follow', {
                time: `${Math.floor(currentTime / 60)}:${String(Math.floor(currentTime % 60)).padStart(2, '0')}`,
              })}
            </span>
          </button>
        </div>
      )}
    </div>
  );
};

export default TranscriptSurface;
