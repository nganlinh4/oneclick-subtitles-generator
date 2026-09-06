import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Inline editable speaker name component.
 * Allows renaming speaker IDs (e.g. 'speaker_0' -> 'Alice') and propagates
 * across all turns with the same speaker ID.
 */
export const SpeakerNameInput = ({
  speakerId,
  displayName,
  onSpeakerRename,
  palette,
}) => {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(displayName || speakerId || 'Speaker');
  const inputRef = useRef(null);

  useEffect(() => {
    setValue(displayName || speakerId || 'Speaker');
  }, [displayName, speakerId]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const handleCommit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== displayName) {
      onSpeakerRename?.(speakerId, trimmed);
    } else {
      setValue(displayName || speakerId || 'Speaker');
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCommit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setValue(displayName || speakerId || 'Speaker');
      setIsEditing(false);
    }
  };

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        className="speaker-name-inline-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleCommit}
        onKeyDown={handleKeyDown}
        aria-label={t('transcript.renameSpeaker', 'Rename speaker')}
        data-testid={`speaker-rename-input-${speakerId}`}
      />
    );
  }

  return (
    <span
      className="speaker-name-display-container"
      onClick={() => setIsEditing(true)}
      title={t('transcript.clickToRenameSpeaker', 'Click to rename speaker across all turns')}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setIsEditing(true);
        }
      }}
      data-testid={`speaker-name-${speakerId}`}
    >
      <span className="speaker-name-text" style={{ color: palette?.onContainer || 'inherit' }}>
        {displayName || speakerId || t('transcript.defaultSpeaker', 'Speaker')}
      </span>
      <span className="material-symbols-rounded speaker-name-edit-icon" aria-hidden="true">
        edit
      </span>
    </span>
  );
};

export default SpeakerNameInput;
