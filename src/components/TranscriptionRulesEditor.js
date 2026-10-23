import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import CloseButton from './common/CloseButton';
import PulsingElement from './common/PulsingElement';
import '../styles/TranscriptionRulesEditor.css';
import { PROMPT_PRESETS, getUserPromptPresets } from '../services/geminiService';
import useCountdownTimer from './transcriptionRules/useCountdownTimer';
import PresetSelector from './transcriptionRules/PresetSelector';
import RulesListSection from './transcriptionRules/RulesListSection';
import { showErrorToast } from '../utils/toastUtils';
import { normalizeUserTranscriptionPromptPresets } from '../services/gemini/transcriptionPromptPresetSelection';
import {
  handleArrayItemChange as changeArrayItem,
  addArrayItem as appendArrayItem,
  removeArrayItem as deleteArrayItem
} from './transcriptionRules/arrayItemHandlers';
import { readPreference, readStoredPreference } from '../platform/preferences/store';
import { activateOnKey } from '../utils/a11y/activateOnKey';

const TranscriptionRulesEditor = ({ isOpen, onClose, initialRules, onSave, onCancel, onChangePrompt }) => {
  const { t } = useTranslation();
  const overlayRef = useRef(null);
  const [isClosing, setIsClosing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const closeInFlightRef = useRef(false);
  const [rules, setRules] = useState(initialRules || {
    atmosphere: '',
    terminology: [],
    speakerIdentification: [],
    formattingConventions: [],
    spellingAndGrammar: [],
    relationships: [],
    additionalNotes: []
  });

  // State for prompt presets
  const [currentPresetId, setCurrentPresetId] = useState('');
  const [userPromptPresets, setUserPromptPresets] = useState([]);

  // Track initial state for change detection
  const [initialState, setInitialState] = useState({
    rules: initialRules || {
      atmosphere: '',
      terminology: [],
      speakerIdentification: [],
      formattingConventions: [],
      spellingAndGrammar: [],
      relationships: [],
      additionalNotes: []
    },
    presetId: 'custom'
  });

  // Get all available presets (built-in + user)
  const allPresets = useMemo(() => [...PROMPT_PRESETS, ...userPromptPresets], [userPromptPresets]);

  // Function to check if there are changes
  const hasChanges = useMemo(() => {
    // Deep compare rules
    const rulesChanged = JSON.stringify(rules) !== JSON.stringify(initialState.rules);

    // Check if preset changed
    const presetChanged = currentPresetId !== initialState.presetId;

    return rulesChanged || presetChanged;
  }, [rules, currentPresetId, initialState]);

  // Handle save
  const handleSave = useCallback(async () => {
    if (saveInFlightRef.current || closeInFlightRef.current) return false;
    saveInFlightRef.current = true;
    setIsSaving(true);

    try {
      await onSave(rules);
      setIsClosing(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      saveInFlightRef.current = false;
      setIsSaving(false);
      onClose('save');
      return true;
    } catch (error) {
      console.error('Transcription rules save failed:', error?.code || 'rulesSaveFailed');
      saveInFlightRef.current = false;
      setIsSaving(false);
      setIsClosing(false);
      showErrorToast(
        t('rulesEditor.saveFailed', 'Transcription rules could not be saved.'),
        5_000,
      );
      return false;
    }
  }, [onClose, onSave, rules, t]);

  // Countdown for autoflow (state, interval/timeout refs and user-interaction guard)
  const { showCountdown, countdown, handleUserInteraction } = useCountdownTimer(isOpen, handleSave);

  // Handle cancel
  const handleCancel = useCallback(() => {
    if (saveInFlightRef.current || closeInFlightRef.current) return false;
    closeInFlightRef.current = true;
    setIsClosing(true);
    setTimeout(() => {
      if (onCancel) {
        onCancel();
      }
      onClose('cancel');
      setIsClosing(false);
    }, 200); // Match the transition duration
    return true;
  }, [onCancel, onClose]);

  // Effect to determine the current preset and set initial state - run when modal opens
  useEffect(() => {
    if (!isOpen) return; // Only run when modal is open

    const loadedUserPresets = getUserPromptPresets();
    const usableUserPresets = normalizeUserTranscriptionPromptPresets(
      loadedUserPresets,
      PROMPT_PRESETS.map(({ id }) => id),
    );

    // The preset the processing modal has stored, if any.
    const savedPresetId = readStoredPreference('video_processing_prompt_preset');

    // If there's an analysis recommendation and no saved preset, use the recommendation as initial value
    const sessionPresetId = sessionStorage.getItem('current_session_preset_id');

    let detectedPresetId = 'custom';

    const knownPresetIds = new Set([
      ...PROMPT_PRESETS.map(({ id }) => id),
      ...usableUserPresets.map(({ id }) => id),
    ]);
    const editorPresetId = (presetId) => {
      if (presetId === 'settings' || presetId === 'custom') return 'custom';
      return knownPresetIds.has(presetId) ? presetId : null;
    };
    const savedEditorPresetId = editorPresetId(savedPresetId);
    const sessionEditorPresetId = editorPresetId(sessionPresetId);

    if (savedEditorPresetId) {
      // Use what's saved (user's choice)
      detectedPresetId = savedEditorPresetId;
      setCurrentPresetId(detectedPresetId);
    } else if (sessionEditorPresetId) {
      // No saved preference, use analysis recommendation as initial value
      detectedPresetId = sessionEditorPresetId;
      setCurrentPresetId(sessionEditorPresetId);
    } else {
      // No saved preference and no recommendation, default to custom
      detectedPresetId = 'custom';
      setCurrentPresetId('custom');
    }

    // Set initial state for change tracking
    setInitialState({
      rules: initialRules || {
        atmosphere: '',
        terminology: [],
        speakerIdentification: [],
        formattingConventions: [],
        spellingAndGrammar: [],
        relationships: [],
        additionalNotes: []
      },
      presetId: detectedPresetId
    });

    // Load user presets
    setUserPromptPresets(usableUserPresets);
  }, [isOpen, initialRules]); // Re-run when modal opens or initial rules change

  // Handle ESC key to close modal and prevent background scrolling
  useEffect(() => {
    const overlay = overlayRef.current;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && isOpen && !saveInFlightRef.current) {
        handleCancel();
      }
    };

    const preventScroll = (e) => {
      // Only prevent scroll if the event target is the overlay itself
      if (e.target === overlayRef.current) {
        e.preventDefault();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.classList.add('modal-open');

      // Add non-passive scroll event listeners to overlay
      if (overlay) {
        overlay.addEventListener('wheel', preventScroll, { passive: false });
        overlay.addEventListener('touchmove', preventScroll, { passive: false });
      }
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.classList.remove('modal-open');

      // Remove scroll event listeners
      if (overlay) {
        overlay.removeEventListener('wheel', preventScroll);
        overlay.removeEventListener('touchmove', preventScroll);
      }
    };
  }, [isOpen, handleCancel]);

  // Handle atmosphere change
  const handleAtmosphereChange = (e) => {
    handleUserInteraction();
    setRules({
      ...rules,
      atmosphere: e.target.value
    });
  };

  // Handle array item change
  const handleArrayItemChange = (category, index, field, value) => {
    handleUserInteraction();
    setRules(changeArrayItem(rules, category, index, field, value));
  };

  // Add new item to array
  const addArrayItem = (category, template) => {
    handleUserInteraction();
    setRules(appendArrayItem(rules, category, template));
  };

  // Remove item from array
  const removeArrayItem = (category, index) => {
    handleUserInteraction();
    setRules(deleteArrayItem(rules, category, index));
  };

  if (!isOpen) return null;

  const listSections = [
    {
      category: 'terminology',
      title: t('videoAnalysis.terminology', 'Terminology & Proper Nouns'),
      description: t('rulesEditor.terminologyDescription', 'Add specialized terms, proper nouns, and their definitions'),
      fields: [
        { name: 'term', placeholder: t('rulesEditor.termPlaceholder', 'Term') },
        { name: 'definition', placeholder: t('rulesEditor.definitionPlaceholder', 'Definition') },
      ],
      template: () => ({ term: '', definition: '' }),
      addLabel: t('rulesEditor.addTerm', '+ Add Term'),
    },
    {
      category: 'speakerIdentification',
      title: t('videoAnalysis.speakerIdentification', 'Speaker Identification'),
      description: t('rulesEditor.speakersDescription', 'Add information about different speakers'),
      fields: [
        { name: 'speakerId', placeholder: t('rulesEditor.speakerIdPlaceholder', 'Speaker ID (e.g., "Speaker 1", "John")') },
        { name: 'description', placeholder: t('rulesEditor.speakerDescPlaceholder', 'Description') },
      ],
      template: () => ({ speakerId: '', description: '' }),
      addLabel: t('rulesEditor.addSpeaker', '+ Add Speaker'),
    },
    {
      category: 'formattingConventions',
      title: t('videoAnalysis.formattingConventions', 'Formatting & Style Conventions'),
      description: t('rulesEditor.formattingDescription', 'Add formatting and style rules'),
      placeholder: t('rulesEditor.conventionPlaceholder', 'Formatting rule...'),
      template: () => '',
      addLabel: t('rulesEditor.addFormatting', '+ Add Formatting Rule'),
    },
    {
      category: 'spellingAndGrammar',
      title: t('videoAnalysis.spellingAndGrammar', 'Spelling, Grammar & Punctuation'),
      description: t('rulesEditor.spellingDescription', 'Add spelling, grammar, and punctuation rules'),
      placeholder: t('rulesEditor.spellingRulePlaceholder', 'Spelling or grammar rule...'),
      template: () => '',
      addLabel: t('rulesEditor.addSpellingRule', '+ Add Spelling/Grammar Rule'),
    },
    {
      category: 'relationships',
      title: t('videoAnalysis.relationships', 'Relationships & Social Hierarchy'),
      description: t('rulesEditor.relationshipsDescription', 'Add information about relationships between people'),
      placeholder: t('rulesEditor.relationshipPlaceholder', 'Relationship information...'),
      template: () => '',
      addLabel: t('rulesEditor.addRelationship', '+ Add Relationship'),
    },
    {
      category: 'additionalNotes',
      title: t('videoAnalysis.additionalNotes', 'Additional Notes'),
      description: t('rulesEditor.notesDescription', 'Add any other notes for consistent transcription'),
      placeholder: t('rulesEditor.notePlaceholder', 'Additional note...'),
      template: () => '',
      addLabel: t('rulesEditor.addNote', '+ Add Note'),
    },
  ];

  return (
    <div
      ref={overlayRef}
      className={`rules-editor-overlay ${isClosing ? 'closing' : ''}`}
      onClick={handleUserInteraction}
    >
      <div
        className={`rules-editor-modal ${showCountdown ? 'with-countdown' : ''} ${isClosing ? 'closing' : ''}`}
        aria-busy={isSaving}
        inert={isSaving || isClosing ? '' : undefined}
        onClick={(e) => {
        e.stopPropagation();
        handleUserInteraction();
        }}
      >
        {showCountdown && (
          <div className="countdown-banner" onClick={handleUserInteraction} role="button" tabIndex={0} onKeyDown={activateOnKey}>
            <div className="countdown-content">
              {countdown === -1 ? (
                <>
                  <span className="countdown-text">
                    {t('rulesEditor.waitingForAction', 'Waiting for your action')}
                  </span>
                  <span className="countdown-hint">
                    {t('rulesEditor.clickToEdit', '(click to start editing)')}
                  </span>
                </>
              ) : (
                <>
                  <span className="countdown-text">
                    {t('rulesEditor.autoSaveCountdown', 'Auto-saving in')}
                  </span>
                  <PulsingElement as="span" className="countdown-number" data-content={countdown}>{countdown}</PulsingElement>
                  <span className="countdown-text">
                    {t('rulesEditor.seconds', 'seconds')}
                  </span>
                  <span className="countdown-hint">
                    {t('rulesEditor.clickToCancel', '(click anywhere to cancel)')}
                  </span>
                </>
              )}
            </div>
            {countdown !== -1 && (
              <div className="countdown-progress">
                <div
                  className="countdown-progress-bar"
                  style={{
                    width: `${((parseInt(readPreference('video_analysis_timeout'), 10) - countdown) / parseInt(readPreference('video_analysis_timeout'), 10)) * 100}%`
                  }}
                />
              </div>
            )}
          </div>
        )}
        <div className="modal-header">
          <h2>{t('rulesEditor.title', 'Edit Transcription Rules')}</h2>
          <PresetSelector
            currentPresetId={currentPresetId}
            setCurrentPresetId={setCurrentPresetId}
            allPresets={allPresets}
            userPromptPresets={userPromptPresets}
            onChangePrompt={onChangePrompt}
            handleUserInteraction={handleUserInteraction}
          />
          <CloseButton onClick={handleCancel} variant="modal" size="medium" disabled={isSaving || isClosing} />
        </div>

        <div className="modal-content">
          <div className="rules-editor-section">
            <h3>{t('videoAnalysis.atmosphere', 'Atmosphere')}</h3>
            <textarea
              value={rules.atmosphere || ''}
              onChange={handleAtmosphereChange}
              onClick={handleUserInteraction}
              onFocus={handleUserInteraction}
              placeholder={t('rulesEditor.atmospherePlaceholder', 'Description of the setting or context...')}
              rows={3}
            />
          </div>

          {listSections.map(({ category, template, ...section }) => (
            <RulesListSection
              key={category}
              {...section}
              items={rules[category]}
              onChangeItem={(index, field, value) => handleArrayItemChange(category, index, field, value)}
              onRemoveItem={(index) => removeArrayItem(category, index)}
              onAddItem={() => addArrayItem(category, template())}
              onInteract={handleUserInteraction}
            />
          ))}
        </div>

        <div className="modal-footer">
          <button className="cancel-button" onClick={handleCancel} disabled={isSaving || isClosing}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            className={`save-button ${!hasChanges && !showCountdown ? 'disabled' : ''} ${showCountdown ? 'autoflow-active' : ''}`}
            onClick={handleSave}
            disabled={isSaving || isClosing || (!hasChanges && !showCountdown)}
          >
            {isSaving
              ? t('rulesEditor.saving', 'Saving...')
              : showCountdown
              ? t('rulesEditor.saveContinue', 'Save & Continue')
              : t('common.save', 'Save')
            }
          </button>
        </div>
      </div>
    </div>
  );
};

export default TranscriptionRulesEditor;
