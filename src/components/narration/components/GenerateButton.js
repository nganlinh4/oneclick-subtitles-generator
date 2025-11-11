import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Generate Button component
 * @param {Object} props - Component props
 * @param {Function} props.handleGenerateNarration - Function to handle narration generation
 * @param {boolean} props.isGenerating - Whether generation is in progress
 * @param {Object} props.referenceAudio - Reference audio object
 * @param {Array} props.generationResults - Generation results
 * @param {Function} props.downloadAllAudio - Function to download all audio
 * @param {Function} props.downloadAlignedAudio - Function to download aligned audio
 * @param {Function} props.cancelGeneration - Function to cancel narration generation
 * @param {string|null} props.subtitleSource - The selected subtitle source
 * @param {boolean} props.isServiceAvailable - Whether the narration service is available
 * @param {string} props.serviceUnavailableMessage - Message to show when service is unavailable
 * @returns {JSX.Element} - Rendered component
 */
const GenerateButton = ({
  handleGenerateNarration,
  isGenerating,
  referenceAudio,
  generationResults,
  downloadAllAudio,
  downloadAlignedAudio,
  cancelGeneration,
  subtitleSource,
  isServiceAvailable = true,
  serviceUnavailableMessage = '',
  narrationMethod = null
}) => {
  const { t } = useTranslation();

  return (
    <div className="narration-row generate-button-row">
      <div className="row-content generate-button-container">
        {/* Left side - Generate/Cancel button */}
        <div className="generate-button-left">
          {isGenerating ? (
            <button
              className="pill-button danger cancel-btn"
              onClick={cancelGeneration}
              disabled={narrationMethod === 'f5tts' || narrationMethod === 'chatterbox'}
              style={(narrationMethod === 'f5tts' || narrationMethod === 'chatterbox') ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
              title={
                narrationMethod === 'f5tts'
                  ? t('narration.f5ttsCancelNotSupported', 'F5-TTS library doesn\'t support cancellation during audio generation')
                  : narrationMethod === 'chatterbox'
                  ? t('narration.chatterboxCancelNotSupported', 'Chatterbox library doesn\'t support cancellation during audio generation')
                  : ''
              }
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16, display: 'inline-block' }}>
                close
              </span>
              {t('narration.cancel', 'Cancel Generation')}
              {(narrationMethod === 'f5tts' || narrationMethod === 'chatterbox') && (
                <span className="material-symbols-rounded" style={{ fontSize: 14, display: 'inline-block', marginLeft: '4px', opacity: 0.7 }}>
                  info
                </span>
              )}
            </button>
          ) : (
            <button
              className="pill-button primary"
              onClick={handleGenerateNarration}
              disabled={(referenceAudio !== null && !referenceAudio) || !subtitleSource || !isServiceAvailable}
              title={
                !isServiceAvailable ? serviceUnavailableMessage :
                !subtitleSource ? t('narration.noSourceSelectedError', 'Please select a subtitle source (Original or Translated)') :
                (referenceAudio !== null && !referenceAudio) ? t('narration.noReferenceAudioError', 'Please upload or record reference audio') : ''
              }
            >
              <span className="material-symbols-rounded" style={{ fontSize: 24, display: 'inline-block' }}>
                motion_play
              </span>
              {t('narration.generate', 'Generate Narration')}
            </button>
          )}
        </div>

        {/* Right side - Download buttons */}
        <div className="generate-button-right">
          <div className="pill-button-group">
            <button
              className="pill-button secondary download-all-btn"
              onClick={downloadAllAudio}
              title={t('narration.downloadAllTooltip', 'Download all generated audio files')}
              disabled={!generationResults || generationResults.length === 0 || !generationResults.some(r => r.success && (r.audioData || r.filename))}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18, display: 'inline-block' }}>
                archive
              </span>
              {t('narration.downloadAll', 'Tải xuống tất cả')}
            </button>

            <button
              className="pill-button secondary"
              onClick={downloadAlignedAudio}
              title={t('narration.downloadAlignedTooltip', 'Tải xuống một tập tin thuyết minh đã sắp xếp')}
              disabled={!generationResults || generationResults.length === 0 || !generationResults.some(r => r.success && (r.audioData || r.filename))}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18, display: 'inline-block' }}>
                system_update_alt
              </span>
              {t('narration.downloadAligned', 'Tải xuống như đã sắp xếp trên timeline')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GenerateButton;
