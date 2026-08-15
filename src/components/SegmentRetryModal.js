import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import CloseButton from './common/CloseButton';
import '../styles/SegmentRetryModal.css';
import {
  DEFAULT_TRANSCRIPTION_MODEL_ID,
  TRANSCRIPTION_MODELS,
  normalizeMediaModelId
} from '../config/geminiModels';

/**
 * Modal component for retrying a segment with custom options
 * @param {Object} props - Component props
 * @param {boolean} props.isOpen - Whether the modal is open
 * @param {Function} props.onClose - Function called when modal is closed
 * @param {number} props.segmentIndex - Index of the segment to retry
 * @param {Array} props.segments - Array of segments
 * @param {Function} props.onRetry - Function called when retry is requested
 * @param {string} props.userProvidedSubtitles - User-provided subtitles for the whole media
 * @returns {JSX.Element} - Rendered component
 */
const SegmentRetryModal = ({
  isOpen,
  onClose,
  segmentIndex,
  segments,
  onRetry,
  userProvidedSubtitles: _userProvidedSubtitles = ''
}) => {
  const { t } = useTranslation();

  // Step management (1: model selection, 2: subtitle options)
  const [currentStep, setCurrentStep] = useState(1);

  // Model selection state
  const [selectedModel, setSelectedModel] = useState(() => normalizeMediaModelId(
    localStorage.getItem('gemini_model'),
    DEFAULT_TRANSCRIPTION_MODEL_ID
  ));

  // Subtitle options state
  const [subtitlesOption, setSubtitlesOption] = useState('none');
  const [customSubtitles, setCustomSubtitles] = useState('');
  const [isPending, setIsPending] = useState(false);
  const textareaRef = useRef(null);
  const mountedRef = useRef(false);
  const pendingRef = useRef(false);
  const requestClose = () => {
    if (!pendingRef.current) onClose();
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Model options derived from central config
  const modelOptions = TRANSCRIPTION_MODELS.map(model => ({
    id: model.id,
    name: t(model.nameKey, model.nameDefault),
    description: t(model.descKey, model.descDefault),
    icon: (
      <span
        className={`material-symbols-rounded ${model.icon.className}`}
        style={model.icon.style}
      >
        {model.icon.symbol}
      </span>
    ),
    color: model.color,
    bgColor: model.bgColor
  }));

  useEffect(() => {
    if (isOpen) {
      // Reset to first step when modal opens
      setCurrentStep(1);
      // Set default model to current model
      setSelectedModel(normalizeMediaModelId(
        localStorage.getItem('gemini_model'),
        DEFAULT_TRANSCRIPTION_MODEL_ID
      ));
      // Reset subtitle options
      setSubtitlesOption('none');
      setCustomSubtitles('');
      pendingRef.current = false;
      setIsPending(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleEscape = (event) => {
      if (event.key === 'Escape' && !pendingRef.current) onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen && textareaRef.current && subtitlesOption === 'custom' && currentStep === 2) {
      textareaRef.current.focus();
    }
  }, [isOpen, subtitlesOption, currentStep]);

  const handleModelSelect = (modelId) => {
    if (pendingRef.current) return;
    setSelectedModel(modelId);
  };

  const handleNextStep = () => {
    if (pendingRef.current) return;
    setCurrentStep(2);
  };

  const handleRetry = async () => {
    if (pendingRef.current) return;
    const options = {
      modelId: selectedModel
    };

    // Add subtitles based on selected option
    if (subtitlesOption === 'custom' && customSubtitles.trim()) {
      options.userProvidedSubtitles = customSubtitles;
    }

    pendingRef.current = true;
    setIsPending(true);
    let succeeded = false;
    try {
      succeeded = await onRetry(segmentIndex, segments, options) === true;
    } catch {
      succeeded = false;
    }
    if (!mountedRef.current) return;
    pendingRef.current = false;
    setIsPending(false);
    if (succeeded) onClose();
  };

  const handleOptionChange = (option) => {
    if (pendingRef.current) return;
    setSubtitlesOption(option);
  };

  const handleCustomSubtitlesChange = (e) => {
    if (pendingRef.current) return;
    setCustomSubtitles(e.target.value);
  };

  if (!isOpen) return null;

  return (
    <div
      className="segment-retry-modal-overlay"
      onClick={() => {
        if (!pendingRef.current) onClose();
      }}
    >
      <div className="segment-retry-modal" onClick={(e) => e.stopPropagation()}>
        <div className="segment-retry-modal-header">
          <h2>
            {currentStep === 1
              ? t('segmentRetry.selectModel', 'Select Model for Segment {{segmentNumber}}', { segmentNumber: segmentIndex + 1 })
              : t('segmentRetry.subtitleOptions', 'Subtitle Options for Segment {{segmentNumber}}', { segmentNumber: segmentIndex + 1 })}
          </h2>
          <div className="step-indicator">
            <span className={`step ${currentStep === 1 ? 'active' : 'completed'}`}>1</span>
            <span className="step-divider"></span>
            <span className={`step ${currentStep === 2 ? 'active' : ''}`}>2</span>
          </div>
          <CloseButton onClick={requestClose} variant="modal" size="medium" disabled={isPending} />
        </div>

        <div className="segment-retry-modal-content">
          {currentStep === 1 ? (
            /* Step 1: Model Selection */
            <div className="model-selection-step">
              <p className="explanation">
                {t('segmentRetry.modelExplanation', 'Select which Gemini model to use for retrying this segment. Different models offer different balances of accuracy and speed.')}
              </p>

              <div className="model-options-list">
                {modelOptions.map((model) => (
                  <div
                    key={model.id}
                    className={`model-option ${selectedModel === model.id ? 'selected' : ''}`}
                    onClick={() => handleModelSelect(model.id)}
                    aria-disabled={isPending}
                    style={{
                      '--model-color': model.color,
                      '--model-bg-color': model.bgColor
                    }}
                  >
                    <div className="model-option-radio">
                      <input
                        type="radio"
                        name="modelOption"
                        checked={selectedModel === model.id}
                        onChange={() => handleModelSelect(model.id)}
                        id={`model-${model.id}`}
                        disabled={isPending}
                      />
                      <label htmlFor={`model-${model.id}`}></label>
                    </div>
                    <div className="model-option-icon">{model.icon}</div>
                    <div className="model-option-text">
                      <div className="model-option-name">
                        {model.name}
                      </div>
                      <div className="model-option-description">{model.description}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* Step 2: Subtitle Options */
            <div className="subtitle-options-step">
              <p className="explanation">
                {t('segmentRetry.explanation',
                  'Choose how you want to retry this segment. You can provide subtitles to help Gemini focus ONLY on timing rather than transcription. When using provided subtitles, Gemini will use EXACTLY the text you provide, word for word, and all other settings are ignored.')}
              </p>

              <div className="subtitle-options">
                <h3>{t('segmentRetry.subtitlesOptions', 'Subtitles Options:')}</h3>

                <div className="option">
                  <label>
                    <input
                      type="radio"
                      name="subtitlesOption"
                      value="none"
                      checked={subtitlesOption === 'none'}
                      onChange={() => handleOptionChange('none')}
                      disabled={isPending}
                    />
                    <span>{t('segmentRetry.noSubtitles', 'No subtitles (Gemini will transcribe from scratch)')}</span>
                  </label>
                </div>

                <div className="option">
                  <label>
                    <input
                      type="radio"
                      name="subtitlesOption"
                      value="custom"
                      checked={subtitlesOption === 'custom'}
                      onChange={() => handleOptionChange('custom')}
                      disabled={isPending}
                    />
                    <span>
                      {t('segmentRetry.useCustomSubtitles', 'Use custom subtitles for this segment')}
                    </span>
                  </label>
                </div>

                {subtitlesOption === 'custom' && (
                  <div className="custom-subtitles">
                    <textarea
                      ref={textareaRef}
                      value={customSubtitles}
                      onChange={handleCustomSubtitlesChange}
                      placeholder={t('segmentRetry.customSubtitlesPlaceholder', 'Enter subtitles for this segment...')}
                      rows={5}
                      disabled={isPending}
                    />
                    <div className="hint">
                      {t('segmentRetry.customSubtitlesHint', 'Enter the text you expect to hear in this segment. Gemini will use EXACTLY these words and focus ONLY on timing them correctly, ignoring all other settings.')}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="segment-retry-modal-footer">
          <button className="cancel-button" onClick={requestClose} disabled={isPending}>
            {t('segmentRetry.cancel', 'Cancel')}
          </button>

          {currentStep === 1 ? (
            <button className="next-button" onClick={handleNextStep} disabled={isPending}>
              {t('segmentRetry.next', 'Next')}
              <span className="material-symbols-rounded next-icon">arrow_forward</span>
            </button>
          ) : (
            <button className="retry-button" onClick={handleRetry} disabled={isPending}>
              <span className="material-symbols-rounded">check</span>
              {t('segmentRetry.retry', 'Retry Segment')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default SegmentRetryModal;
