import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import LoadingIndicator from './common/LoadingIndicator';
import '../styles/AddSubtitlesButton.css';
import SubtitlesInputModal from './SubtitlesInputModal';
import { showErrorToast } from '../utils/toastUtils';

/**
 * Button component for adding pre-written subtitles without timings
 * @param {Object} props - Component props
 * @param {Function} props.onSubtitlesAdd - Function called when subtitles are added
 * @param {boolean} props.hasSubtitles - Whether subtitles have been added
 * @param {string} props.subtitlesText - The current subtitles text
 * @param {boolean} props.disabled - Whether the button is disabled
 * @returns {JSX.Element} - Rendered component
 */
const AddSubtitlesButton = ({
  onSubtitlesAdd,
  hasSubtitles = false,
  subtitlesText = '',
  disabled = false,
  onGenerateBackground
}) => {
  const { t } = useTranslation();
  const [showModal, setShowModal] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [localHasSubtitles, setLocalHasSubtitles] = useState(hasSubtitles);
  const [localSubtitlesText, setLocalSubtitlesText] = useState(subtitlesText);
  const operationInFlightRef = useRef(false);

  // Update local state when props change
  useEffect(() => {
    setLocalHasSubtitles(hasSubtitles);
    setLocalSubtitlesText(subtitlesText);
  }, [hasSubtitles, subtitlesText]);

  const handleButtonClick = () => {
    if (localHasSubtitles) {
      // If subtitles are already added, show the modal to edit them
      setShowModal(true);
    } else {
      // If no subtitles yet, show the modal to add them
      setShowModal(true);
    }
  };

  const handleSaveSubtitles = async (text) => {
    if (operationInFlightRef.current) return false;
    operationInFlightRef.current = true;
    setIsProcessing(true);

    try {
      await onSubtitlesAdd(text);
      setLocalHasSubtitles(text.trim() !== '');
      setLocalSubtitlesText(text);
      return true;
    } finally {
      operationInFlightRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleCloseModal = () => {
    setShowModal(false);
  };

  const handleClearSubtitles = async (e) => {
    e.stopPropagation(); // Prevent button click from triggering
    if (operationInFlightRef.current) return false;
    operationInFlightRef.current = true;
    setIsProcessing(true);

    try {
      await onSubtitlesAdd('');
      setLocalHasSubtitles(false);
      setLocalSubtitlesText('');
      return true;
    } catch {
      showErrorToast(
        t('subtitlesInput.saveFailed', 'The subtitles could not be saved. Please try again.'),
        5_000,
      );
      return false;
    } finally {
      operationInFlightRef.current = false;
      setIsProcessing(false);
    }
  };

  return (
    <>
      <div className="add-subtitles-buttons-group">
        <div className="add-subtitles-button-container">
          <button
            className={`add-subtitles-button ${localHasSubtitles ? 'has-subtitles' : ''} ${isProcessing ? 'processing' : ''}`}
            onClick={handleButtonClick}
            disabled={disabled || isProcessing}
            title={localHasSubtitles
              ? t('subtitlesInput.editSubtitles', 'Edit provided subtitles')
              : t('subtitlesInput.addSubtitles', 'Add your own subtitles without timings')}
          >
            {/* Dynamic Gemini effects container - populated by particle system */}
            <div className="gemini-icon-container"></div>

          {isProcessing ? (
            <span className="processing-text-container">
              <LoadingIndicator
                theme="light"
                showContainer={false}
                size={16}
                className="subtitles-processing-loading"
                color="#FFFFFF"
              />
              <span className="processing-text">
                {t('subtitlesInput.processing', 'Processing...')}
              </span>
            </span>
          ) : localHasSubtitles ? (
            <>
              <span className="material-symbols-rounded icon">check</span>
              <span>{t('subtitlesInput.subtitlesAdded', 'Subtitles added')}</span>
            </>
          ) : (
            <>
              <span className="material-symbols-rounded icon" aria-hidden="true">subject</span>
              <span>{t('subtitlesInput.addSubtitles', 'Add subtitles')}</span>
            </>
          )}
        </button>
        </div>

        {/* Separate clear button */}
        {localHasSubtitles && !isProcessing && (
          <button
            className="clear-subtitles-button"
            onClick={handleClearSubtitles}
            title={t('subtitlesInput.clearSubtitles', 'Clear subtitles')}
            data-tooltip={t('subtitlesInput.clearSubtitles', 'Clear subtitles')}
            aria-label={t('subtitlesInput.clearSubtitles', 'Clear subtitles')}
            disabled={disabled}
          >
            <span className="material-symbols-rounded" style={{ fontSize: '18px' }}>close</span>
          </button>
        )}
      </div>

      {showModal && (
        <>

          <SubtitlesInputModal
            initialText={localSubtitlesText}
            onSave={handleSaveSubtitles}
            onClose={handleCloseModal}
            onGenerateBackground={onGenerateBackground}
          />
        </>
      )}
    </>
  );
};

export default AddSubtitlesButton;
