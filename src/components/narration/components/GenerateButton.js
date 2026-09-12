import { useTranslation } from 'react-i18next';
import { getNativeNarrationArtifactId } from '../../../platform/nativeNarrationCapabilities';

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
  isServiceAvailable = false,
  serviceUnavailableMessage = '',
  narrationMethod = null,
  generationBlockedReason = ''
}) => {
  const { t } = useTranslation();

  const requiresReference = narrationMethod === 'f5tts' || narrationMethod === 'chatterbox';
  const referenceMissing = requiresReference
    && !getNativeNarrationArtifactId(referenceAudio);
  const referenceMissingMessage = t(
    'narration.noReferenceAudioError',
    'Please upload or record reference audio first'
  );
  const generationUnavailable = isServiceAvailable !== true
    || referenceMissing
    || !!generationBlockedReason
    || !subtitleSource;
  const nativeResults = Array.isArray(generationResults)
    ? generationResults.filter((result) => (
      result.success === true && getNativeNarrationArtifactId(result) !== null
    ))
    : [];
  const hasNativeResults = nativeResults.length > 0;
  const hasCompleteNativeResults = Array.isArray(generationResults)
    && generationResults.length > 0
    && nativeResults.length === generationResults.length;
  const generate = () => {
    if (!generationUnavailable) handleGenerateNarration();
  };

  return (
    <div className="narration-row generate-button-row">
      <div className="row-content generate-button-container">
        {/* Left side - Generate/Cancel button */}
        <div className="generate-button-left">
          {isGenerating ? (
            <button
              className="pill-button danger cancel-btn"
              onClick={cancelGeneration}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16, display: 'inline-block' }}>
                close
              </span>
              {t('narration.cancel', 'Cancel Generation')}
            </button>
          ) : (
            <button
              className="pill-button primary"
              data-osg-action="generate-narration"
              data-narration-method={narrationMethod || 'unknown'}
              onClick={generate}
              disabled={generationUnavailable}
              title={
                !isServiceAvailable ? serviceUnavailableMessage :
                referenceMissing ? referenceMissingMessage :
                generationBlockedReason || (!subtitleSource
                  ? t('narration.noSourceSelectedError', 'Please select a subtitle source (Original or Translated)')
                  : '')
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
              disabled={!hasNativeResults}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18, display: 'inline-block' }}>
                archive
              </span>
              {t('narration.downloadAll', 'Tải xuống tất cả')}
            </button>

            <button
              className="pill-button secondary"
              data-osg-action="download-aligned-narration"
              onClick={downloadAlignedAudio}
              title={t('narration.downloadAlignedTooltip', 'Tải xuống một tập tin thuyết minh đã sắp xếp')}
              disabled={!hasCompleteNativeResults}
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
