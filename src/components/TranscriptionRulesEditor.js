import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import CloseButton from './common/CloseButton';
import PulsingElement from './common/PulsingElement';
import '../styles/TranscriptionRulesEditor.css';
import { PROMPT_PRESETS, getUserPromptPresets } from '../services/geminiService';
import useCountdownTimer from './transcriptionRules/useCountdownTimer';
import PresetSelector from './transcriptionRules/PresetSelector';
import {
  handleArrayItemChange as changeArrayItem,
  addArrayItem as appendArrayItem,
  removeArrayItem as deleteArrayItem
} from './transcriptionRules/arrayItemHandlers';

const TranscriptionRulesEditor = ({ isOpen, onClose, initialRules, onSave, onCancel, onChangePrompt }) => {
  const { t } = useTranslation();
  const overlayRef = useRef(null);
  const [isClosing, setIsClosing] = useState(false);
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
  const handleSave = () => {
    setIsClosing(true);
    setTimeout(() => {
      onSave(rules);
      onClose('save');
      setIsClosing(false);
    }, 200); // Match the transition duration
  };

  // Countdown for autoflow (state, interval/timeout refs and user-interaction guard)
  const { showCountdown, countdown, handleUserInteraction } = useCountdownTimer(isOpen, handleSave);

  // Handle cancel
  const handleCancel = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      if (onCancel) {
        onCancel();
      }
      onClose('cancel');
      setIsClosing(false);
    }, 200); // Match the transition duration
  }, [onCancel, onClose]);

  // Effect to determine the current preset and set initial state - run when modal opens
  useEffect(() => {
    if (!isOpen) return; // Only run when modal is open

    // SIMPLE: Check what's currently saved in localStorage
    const savedPresetId = localStorage.getItem('video_processing_prompt_preset');

    // If there's an analysis recommendation and no saved preset, use the recommendation as initial value
    const sessionPresetId = sessionStorage.getItem('current_session_preset_id');

    let detectedPresetId = 'custom';

    if (savedPresetId) {
      // Use what's saved (user's choice)
      console.log('[TranscriptionRulesEditor] Using saved preset:', savedPresetId);
      detectedPresetId = savedPresetId === 'settings' ? 'custom' : savedPresetId;
      setCurrentPresetId(detectedPresetId);
    } else if (sessionPresetId) {
      // No saved preference, use analysis recommendation as initial value
      console.log('[TranscriptionRulesEditor] Using analysis recommendation as initial value:', sessionPresetId);
      detectedPresetId = sessionPresetId;
      setCurrentPresetId(sessionPresetId);
      // Save it immediately so it persists
      localStorage.setItem('video_processing_prompt_preset', sessionPresetId);
    } else {
      // No saved preference and no recommendation, default to custom
      console.log('[TranscriptionRulesEditor] No saved preset or recommendation, defaulting to custom');
      detectedPresetId = 'custom';
      setCurrentPresetId('custom');
      localStorage.setItem('video_processing_prompt_preset', 'settings');
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
    setUserPromptPresets(getUserPromptPresets());
  }, [isOpen, initialRules]); // Re-run when modal opens or initial rules change

  // Handle ESC key to close modal and prevent background scrolling
  useEffect(() => {
    const overlay = overlayRef.current;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && isOpen) {
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

  return (
    <div
      ref={overlayRef}
      className={`rules-editor-overlay ${isClosing ? 'closing' : ''}`}
      onClick={handleUserInteraction}
    >
      <div className={`rules-editor-modal ${showCountdown ? 'with-countdown' : ''} ${isClosing ? 'closing' : ''}`} onClick={(e) => {
        e.stopPropagation();
        handleUserInteraction();
      }}>
        {showCountdown && (
          <div className="countdown-banner" onClick={handleUserInteraction}>
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
                    width: `${((parseInt(localStorage.getItem('video_analysis_timeout') || '10', 10) - countdown) / parseInt(localStorage.getItem('video_analysis_timeout') || '10', 10)) * 100}%`
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
          <CloseButton onClick={handleCancel} variant="modal" size="medium" />
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

          <div className="rules-editor-section">
            <h3>{t('videoAnalysis.terminology', 'Terminology & Proper Nouns')}</h3>
            <p className="section-description">{t('rulesEditor.terminologyDescription', 'Add specialized terms, proper nouns, and their definitions')}</p>

            {(rules.terminology || []).map((term, index) => (
              <div key={index} className="array-item-row">
                <div className="term-inputs">
                  <input
                    value={term.term || ''}
                    onChange={(e) => handleArrayItemChange('terminology', index, 'term', e.target.value)}
                    onClick={handleUserInteraction}
                    onFocus={handleUserInteraction}
                    placeholder={t('rulesEditor.termPlaceholder', 'Term')}
                  />
                  <input
                    value={term.definition || ''}
                    onChange={(e) => handleArrayItemChange('terminology', index, 'definition', e.target.value)}
                    onClick={handleUserInteraction}
                    onFocus={handleUserInteraction}
                    placeholder={t('rulesEditor.definitionPlaceholder', 'Definition')}
                    className="definition-input"
                  />
                </div>
                <button
                  className="remove-item-button"
                  onClick={() => {
                    handleUserInteraction();
                    removeArrayItem('terminology', index);
                  }}
                >
                  <span
                    className="material-symbols-rounded"
                    style={{ fontSize: 16, display: 'inline-block' }}
                    aria-hidden="true"
                  >
                    close
                  </span>
                </button>
              </div>
            ))}

            <button
              className="add-item-button"
              onClick={() => {
                handleUserInteraction();
                addArrayItem('terminology', { term: '', definition: '' });
              }}
            >
              {t('rulesEditor.addTerm', '+ Add Term')}
            </button>
          </div>

          <div className="rules-editor-section">
            <h3>{t('videoAnalysis.speakerIdentification', 'Speaker Identification')}</h3>
            <p className="section-description">{t('rulesEditor.speakersDescription', 'Add information about different speakers')}</p>

            {(rules.speakerIdentification || []).map((speaker, index) => (
              <div key={index} className="array-item-row">
                <div className="term-inputs">
                  <input
                    value={speaker.speakerId || ''}
                    onChange={(e) => handleArrayItemChange('speakerIdentification', index, 'speakerId', e.target.value)}
                    placeholder={t('rulesEditor.speakerIdPlaceholder', 'Speaker ID (e.g., "Speaker 1", "John")')}
                  />
                  <input
                    value={speaker.description || ''}
                    onChange={(e) => handleArrayItemChange('speakerIdentification', index, 'description', e.target.value)}
                    placeholder={t('rulesEditor.speakerDescPlaceholder', 'Description')}
                    className="definition-input"
                  />
                </div>
                <button
                  className="remove-item-button"
                  onClick={() => removeArrayItem('speakerIdentification', index)}
                >
                  <span
                    className="material-symbols-rounded"
                    style={{ fontSize: 16, display: 'inline-block' }}
                    aria-hidden="true"
                  >
                    close
                  </span>
                </button>
              </div>
            ))}

            <button
              className="add-item-button"
              onClick={() => addArrayItem('speakerIdentification', { speakerId: '', description: '' })}
            >
              {t('rulesEditor.addSpeaker', '+ Add Speaker')}
            </button>
          </div>

          <div className="rules-editor-section">
            <h3>{t('videoAnalysis.formattingConventions', 'Formatting & Style Conventions')}</h3>
            <p className="section-description">{t('rulesEditor.formattingDescription', 'Add formatting and style rules')}</p>

            {(rules.formattingConventions || []).map((convention, index) => (
              <div key={index} className="array-item-row">
                <input
                  value={convention || ''}
                  onChange={(e) => handleArrayItemChange('formattingConventions', index, null, e.target.value)}
                  placeholder={t('rulesEditor.conventionPlaceholder', 'Formatting rule...')}
                  className="full-width-input"
                />
                <button
                  className="remove-item-button"
                  onClick={() => removeArrayItem('formattingConventions', index)}
                >
                  <span
                    className="material-symbols-rounded"
                    style={{ fontSize: 16, display: 'inline-block' }}
                    aria-hidden="true"
                  >
                    close
                  </span>
                </button>
              </div>
            ))}

            <button
              className="add-item-button"
              onClick={() => addArrayItem('formattingConventions', '')}
            >
              {t('rulesEditor.addFormatting', '+ Add Formatting Rule')}
            </button>
          </div>

          <div className="rules-editor-section">
            <h3>{t('videoAnalysis.spellingAndGrammar', 'Spelling, Grammar & Punctuation')}</h3>
            <p className="section-description">{t('rulesEditor.spellingDescription', 'Add spelling, grammar, and punctuation rules')}</p>

            {(rules.spellingAndGrammar || []).map((rule, index) => (
              <div key={index} className="array-item-row">
                <input
                  value={rule || ''}
                  onChange={(e) => handleArrayItemChange('spellingAndGrammar', index, null, e.target.value)}
                  placeholder={t('rulesEditor.spellingRulePlaceholder', 'Spelling or grammar rule...')}
                  className="full-width-input"
                />
                <button
                  className="remove-item-button"
                  onClick={() => removeArrayItem('spellingAndGrammar', index)}
                >
                  <span
                    className="material-symbols-rounded"
                    style={{ fontSize: 16, display: 'inline-block' }}
                    aria-hidden="true"
                  >
                    close
                  </span>
                </button>
              </div>
            ))}

            <button
              className="add-item-button"
              onClick={() => addArrayItem('spellingAndGrammar', '')}
            >
              {t('rulesEditor.addSpellingRule', '+ Add Spelling/Grammar Rule')}
            </button>
          </div>

          <div className="rules-editor-section">
            <h3>{t('videoAnalysis.relationships', 'Relationships & Social Hierarchy')}</h3>
            <p className="section-description">{t('rulesEditor.relationshipsDescription', 'Add information about relationships between people')}</p>

            {(rules.relationships || []).map((relationship, index) => (
              <div key={index} className="array-item-row">
                <input
                  value={relationship || ''}
                  onChange={(e) => handleArrayItemChange('relationships', index, null, e.target.value)}
                  placeholder={t('rulesEditor.relationshipPlaceholder', 'Relationship information...')}
                  className="full-width-input"
                />
                <button
                  className="remove-item-button"
                  onClick={() => removeArrayItem('relationships', index)}
                >
                  <span
                    className="material-symbols-rounded"
                    style={{ fontSize: 16, display: 'inline-block' }}
                    aria-hidden="true"
                  >
                    close
                  </span>
                </button>
              </div>
            ))}

            <button
              className="add-item-button"
              onClick={() => addArrayItem('relationships', '')}
            >
              {t('rulesEditor.addRelationship', '+ Add Relationship')}
            </button>
          </div>

          <div className="rules-editor-section">
            <h3>{t('videoAnalysis.additionalNotes', 'Additional Notes')}</h3>
            <p className="section-description">{t('rulesEditor.notesDescription', 'Add any other notes for consistent transcription')}</p>

            {(rules.additionalNotes || []).map((note, index) => (
              <div key={index} className="array-item-row">
                <input
                  value={note || ''}
                  onChange={(e) => handleArrayItemChange('additionalNotes', index, null, e.target.value)}
                  placeholder={t('rulesEditor.notePlaceholder', 'Additional note...')}
                  className="full-width-input"
                />
                <button
                  className="remove-item-button"
                  onClick={() => removeArrayItem('additionalNotes', index)}
                >
                  <span
                    className="material-symbols-rounded"
                    style={{ fontSize: 16, display: 'inline-block' }}
                    aria-hidden="true"
                  >
                    close
                  </span>
                </button>
              </div>
            ))}

            <button
              className="add-item-button"
              onClick={() => addArrayItem('additionalNotes', '')}
            >
              {t('rulesEditor.addNote', '+ Add Note')}
            </button>
          </div>
        </div>

        <div className="modal-footer">
          <button className="cancel-button" onClick={handleCancel}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            className={`save-button ${!hasChanges && !showCountdown ? 'disabled' : ''} ${showCountdown ? 'autoflow-active' : ''}`}
            onClick={handleSave}
            disabled={!hasChanges && !showCountdown}
          >
            {showCountdown
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
