import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/VideoAnalysisModal.css';
import { PROMPT_PRESETS } from '../services/geminiService';

const VideoAnalysisModal = ({
  isOpen,
  onClose,
  analysisResult,
  onUsePreset,
  onUseDefaultPreset,
  onEditRules
}) => {
  const { t } = useTranslation();
  const [showRules, setShowRules] = useState(false);

  // Clean up localStorage on unmount to prevent stale data
  useEffect(() => {
    // Check if this is a page refresh. Guard getEntriesByType — the Performance Timeline
    // API isn't available in every environment (older browsers, jsdom/test, faked timers).
    const pageWasReloaded =
      window.performance?.getEntriesByType?.('navigation')?.[0]?.type === 'reload' ||
      document.referrer === document.location.href;

    if (pageWasReloaded) {
      // Clear analysis data on page refresh
      localStorage.removeItem('show_video_analysis');
      localStorage.removeItem('video_analysis_timestamp');
      localStorage.removeItem('video_analysis_result');

    }

    // Clean up on unmount
    return () => {
      // We don't want to clear localStorage when the modal is closed normally
      // as that's handled by the parent component
    };
  }, []);

  // Set up state for auto-selection of recommended preset
  const [countdown, setCountdown] = useState(null);
  const [userInteracted, setUserInteracted] = useState(false);
  const [autoSelectMessageType, setAutoSelectMessageType] = useState('recommended'); // 'recommended' or 'default'
  const [isDefaultAutoSelected, setIsDefaultAutoSelected] = useState(false);

  // Use refs to store timers without triggering re-renders
  const intervalRef = useRef(null);
  const timeoutRef = useRef(null);
  const onUseDefaultPresetRef = useRef(onUseDefaultPreset);
  onUseDefaultPresetRef.current = onUseDefaultPreset;

  // Initialize countdown on mount only
  useEffect(() => {
    // Only initialize if we have valid data and user hasn't interacted
    if (!isOpen || !analysisResult?.recommendedPreset?.id || userInteracted) {
      return;
    }

    // Determine message type and primary action based on localStorage
    const autoSelectDefaultSetting = localStorage.getItem('auto_select_default_preset') === 'true';
    setAutoSelectMessageType(autoSelectDefaultSetting ? 'default' : 'recommended');
    setIsDefaultAutoSelected(autoSelectDefaultSetting);

    // Get timeout setting from localStorage
    const timeoutSetting = localStorage.getItem('video_analysis_timeout') || '20';
    if (timeoutSetting === 'none') {
      return;
    }

    // Parse the timeout setting
    const seconds = parseInt(timeoutSetting, 10);
    if (isNaN(seconds) || seconds <= 0) {
      return;
    }



    // Set initial countdown value
    setCountdown(seconds);

    // Set up the timeout for auto-selection
    timeoutRef.current = setTimeout(() => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      const autoSelectDefault = localStorage.getItem('auto_select_default_preset') === 'true';
      if (autoSelectDefault) {
        onUseDefaultPresetRef.current();
      } else {
        onUsePreset(analysisResult.recommendedPreset.id);
      }
    }, seconds * 1000);

    // Set up interval to update the countdown display
    intervalRef.current = setInterval(() => {
      setCountdown(prevCountdown => {
        const newValue = prevCountdown - 1;
        return newValue > 0 ? newValue : 0;
      });
    }, 1000);

    // Clean up on unmount or when dependencies change
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [isOpen, analysisResult?.recommendedPreset?.id, onUsePreset, userInteracted]); // Only essential dependencies

  // Get preset title based on ID
  const getPresetTitle = (presetId) => {
    const preset = PROMPT_PRESETS.find(p => p.id === presetId);
    if (!preset) return presetId;

    switch (preset.id) {
      case 'general':
        return t('settings.presetGeneralPurpose', 'General purpose');
      case 'extract-text':
        return t('settings.presetExtractText', 'Extract text');
      case 'focus-lyrics':
        return t('settings.presetFocusLyrics', 'Focus on Lyrics');
      case 'describe-video':
        return t('settings.presetDescribeVideo', 'Describe video');
      case 'translate-directly':
        return t('settings.presetTranslateDirectly', 'Translate directly');
      case 'chaptering':
        return t('settings.presetChaptering', 'Chaptering');
      case 'diarize-speakers':
        return t('settings.presetIdentifySpeakers', 'Identify Speakers');
      default:
        return preset.title || presetId;
    }
  };



  // Handle preview and edit rules
  const handlePreviewRules = () => {
    setShowRules(true);
  };

  // Handle use default preset
  const handleUseDefaultPreset = () => {
    onUseDefaultPreset();
  };

  // Handle edit rules
  const handleEditRules = () => {
    // Call the parent component's onEditRules function
    onEditRules(analysisResult.transcriptionRules);
    // Don't reset the local state here - let the parent component handle the transition completely
    // The parent component (App.js) will handle closing this modal and opening the rules editor
  };

  // Handle continue with rules
  const handleContinueWithRules = () => {
    setShowRules(false);
    onUsePreset(analysisResult.recommendedPreset.id);
  };

  // Handle user interaction to cancel auto-selection
  const handleUserInteraction = () => {
    if (!userInteracted && countdown !== null) {
      setUserInteracted(true);

      // Clear the interval and timeout using refs
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      // Reset countdown
      setCountdown(null);
    }
  };


  // Always show the modal when it's rendered
  // isOpen is now ignored

  if (!analysisResult) {
    // Try to get analysis result from localStorage
    try {
      const storedResultString = localStorage.getItem('video_analysis_result');
      if (!storedResultString) {
        // Clear localStorage flags to ensure modal doesn't show again
        localStorage.removeItem('show_video_analysis');
        localStorage.removeItem('video_analysis_timestamp');
        localStorage.removeItem('video_analysis_result');
        if (onClose) onClose();
        return null;
      }

      // Try to parse the stored result
      try {
        const storedResult = JSON.parse(storedResultString);
        if (storedResult) {
          analysisResult = storedResult;
        } else {
          throw new Error('Invalid analysis result structure');
        }
      } catch (parseError) {
        console.error('Error parsing analysis result from localStorage:', parseError);
        // Create a default analysis result
        analysisResult = {
          recommendedPreset: {
            id: 'general',
            reason: 'Default preset selected due to parsing error in stored analysis result'
          },
          transcriptionRules: {
            additionalNotes: ['The original analysis result could not be parsed. Using default settings.']
          }
        };
      }
    } catch (error) {
      console.error('Error accessing localStorage:', error);
      // Clear localStorage flags to ensure modal doesn't show again
      localStorage.removeItem('show_video_analysis');
      localStorage.removeItem('video_analysis_timestamp');
      localStorage.removeItem('video_analysis_result');
      if (onClose) onClose();
      return null;
    }
  }

  // Video analysis is always enabled

  // Additional check to ensure we have valid data
  if (!analysisResult || !analysisResult.recommendedPreset || !analysisResult.transcriptionRules) {
    console.error('Invalid analysis result structure:', analysisResult);
    // Clear localStorage flags to ensure modal doesn't show again
    localStorage.removeItem('show_video_analysis');
    localStorage.removeItem('video_analysis_timestamp');
    localStorage.removeItem('video_analysis_result');
    if (onClose) onClose();
    return null;
  }

  return (
    <div className="video-analysis-modal-overlay" onClick={handleUserInteraction}>
      <div className="video-analysis-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {!showRules ? (
          <>
            <div className="modal-header">
              <h2>{t('videoAnalysis.title', 'Video Analysis Results')}</h2>
            </div>
            <div className="modal-content">
              <div className="analysis-result">
                {countdown !== null && (
                  <div className="timer-section" onClick={handleUserInteraction}>
                    <p>
                      {autoSelectMessageType === 'default'
                        ? t('videoAnalysis.autoSelectDefaultCountdown', { countdown })
                        : t('videoAnalysis.autoSelectRecommendedCountdown', { countdown })
                      }
                      {' '} {/* Ensure space before span */}
                      <span className="timer">{countdown}</span>
                      {' '} {/* Ensure space before seconds */}
                      {t('videoAnalysis.seconds', 'seconds')}
                    </p>
                  </div>
                )}
                <div className="recommended-preset">
                  <h3>{t('videoAnalysis.recommendedPreset', 'Recommended Preset')}</h3>
                  <div className="preset-card">
                    <h4>{getPresetTitle(analysisResult.recommendedPreset.id)}</h4>
                    <p>{analysisResult.recommendedPreset.reason}</p>
                  </div>
                </div>

                <div className="transcription-rules-summary">
                  <h3>{t('videoAnalysis.transcriptionRules', 'Transcription Rules')}</h3>
                  <p>{t('videoAnalysis.rulesDescription', 'A set of rules has been generated to ensure consistent transcription of this video.')}</p>
                  <button
                    className="preview-rules-button"
                    onClick={() => {
                      handleUserInteraction();
                      handlePreviewRules();
                    }}
                  >
                    {t('videoAnalysis.previewRules', 'Preview & Edit Rules')}
                  </button>
                </div>
              </div>


            </div>
            <div className="modal-footer">
              {isDefaultAutoSelected ? (
                <>
                  <button
                    className="use-default-button" // Secondary style
                    onClick={() => {
                      handleUserInteraction();
                      onUsePreset(analysisResult.recommendedPreset.id);
                    }}
                  >
                    {t('videoAnalysis.useRecommended', 'Use Recommended')}
                  </button>
                  <button
                    className="use-recommended-button" // Primary style
                    onClick={() => {
                      handleUserInteraction();
                      handleUseDefaultPreset();
                    }}
                  >
                    {t('videoAnalysis.useDefaultPreset', 'Use My Default Preset')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="use-default-button" // Secondary style
                    onClick={() => {
                      handleUserInteraction();
                      handleUseDefaultPreset();
                    }}
                  >
                    {t('videoAnalysis.useDefaultPreset', 'Use My Default Preset')}
                  </button>
                  <button
                    className="use-recommended-button" // Primary style
                    onClick={() => {
                      handleUserInteraction();
                      onUsePreset(analysisResult.recommendedPreset.id);
                    }}
                  >
                    {t('videoAnalysis.useRecommended', 'Use Recommended')}
                  </button>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="modal-header">
              <h2>{t('videoAnalysis.transcriptionRules', 'Transcription Rules')}</h2>
            </div>
            <div className="modal-content rules-content">
              {analysisResult.transcriptionRules.atmosphere && (
                <div className="rule-section">
                  <h3>{t('videoAnalysis.atmosphere', 'Atmosphere')}</h3>
                  <p>{analysisResult.transcriptionRules.atmosphere}</p>
                </div>
              )}

              {analysisResult.transcriptionRules.terminology &&
               Array.isArray(analysisResult.transcriptionRules.terminology) &&
               analysisResult.transcriptionRules.terminology.length > 0 && (
                <div className="rule-section">
                  <h3>{t('videoAnalysis.terminology', 'Terminology & Proper Nouns')}</h3>
                  <ul className="terminology-list">
                    {analysisResult.transcriptionRules.terminology.map((term, index) => {
                      // Check if term is a valid object with required properties
                      if (!term || typeof term !== 'object' || !term.term) {
                        return null; // Skip invalid terms
                      }
                      return (
                        <li key={index}>
                          <strong>{term.term}</strong>: {term.definition || 'No definition provided'}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {analysisResult.transcriptionRules.speakerIdentification &&
               Array.isArray(analysisResult.transcriptionRules.speakerIdentification) &&
               analysisResult.transcriptionRules.speakerIdentification.length > 0 && (
                <div className="rule-section">
                  <h3>{t('videoAnalysis.speakerIdentification', 'Speaker Identification')}</h3>
                  <ul className="speakers-list">
                    {analysisResult.transcriptionRules.speakerIdentification.map((speaker, index) => {
                      // Check if speaker is a valid object with required properties
                      if (!speaker || typeof speaker !== 'object' || !speaker.speakerId) {
                        return null; // Skip invalid speakers
                      }
                      return (
                        <li key={index}>
                          <strong>{speaker.speakerId}</strong>: {speaker.description || 'No description provided'}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {analysisResult.transcriptionRules.formattingConventions &&
               Array.isArray(analysisResult.transcriptionRules.formattingConventions) &&
               analysisResult.transcriptionRules.formattingConventions.length > 0 && (
                <div className="rule-section">
                  <h3>{t('videoAnalysis.formattingConventions', 'Formatting & Style Conventions')}</h3>
                  <ul>
                    {analysisResult.transcriptionRules.formattingConventions.map((convention, index) => {
                      // Skip null or undefined conventions
                      if (convention === null || convention === undefined) {
                        return null;
                      }
                      return <li key={index}>{String(convention)}</li>;
                    })}
                  </ul>
                </div>
              )}

              {analysisResult.transcriptionRules.spellingAndGrammar &&
               Array.isArray(analysisResult.transcriptionRules.spellingAndGrammar) &&
               analysisResult.transcriptionRules.spellingAndGrammar.length > 0 && (
                <div className="rule-section">
                  <h3>{t('videoAnalysis.spellingAndGrammar', 'Spelling, Grammar & Punctuation')}</h3>
                  <ul>
                    {analysisResult.transcriptionRules.spellingAndGrammar.map((rule, index) => {
                      // Skip null or undefined rules
                      if (rule === null || rule === undefined) {
                        return null;
                      }
                      return <li key={index}>{String(rule)}</li>;
                    })}
                  </ul>
                </div>
              )}

              {analysisResult.transcriptionRules.relationships &&
               Array.isArray(analysisResult.transcriptionRules.relationships) &&
               analysisResult.transcriptionRules.relationships.length > 0 && (
                <div className="rule-section">
                  <h3>{t('videoAnalysis.relationships', 'Relationships & Social Hierarchy')}</h3>
                  <ul>
                    {analysisResult.transcriptionRules.relationships.map((relationship, index) => {
                      // Skip null or undefined relationships
                      if (relationship === null || relationship === undefined) {
                        return null;
                      }
                      return <li key={index}>{String(relationship)}</li>;
                    })}
                  </ul>
                </div>
              )}

              {analysisResult.transcriptionRules.additionalNotes &&
               Array.isArray(analysisResult.transcriptionRules.additionalNotes) &&
               analysisResult.transcriptionRules.additionalNotes.length > 0 && (
                <div className="rule-section">
                  <h3>{t('videoAnalysis.additionalNotes', 'Additional Notes')}</h3>
                  <ul>
                    {analysisResult.transcriptionRules.additionalNotes.map((note, index) => {
                      // Skip null or undefined notes
                      if (note === null || note === undefined) {
                        return null;
                      }
                      return <li key={index}>{String(note)}</li>;
                    })}
                  </ul>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button
                className="back-button"
                onClick={() => {
                  handleUserInteraction();
                  setShowRules(false);
                }}
              >
                {t('videoAnalysis.back', 'Back')}
              </button>
              <button
                className="edit-rules-button"
                onClick={() => {
                  handleUserInteraction();
                  handleEditRules();
                }}
              >
                {t('videoAnalysis.editRules', 'Edit Rules')}
              </button>
              <button
                className="continue-button"
                onClick={() => {
                  handleUserInteraction();
                  handleContinueWithRules();
                }}
              >
                {t('videoAnalysis.continueWithRules', 'Continue with These Rules')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default VideoAnalysisModal;
