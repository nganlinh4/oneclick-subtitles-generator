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
 * @returns {JSX.Element} - Rendered component
 */
const GenerateButton = ({
  handleGenerateNarration,
  isGenerating,
  referenceAudio,
  generationResults,
  downloadAllAudio,
  downloadAlignedAudio,
  cancelGeneration
}) => {
  const { t } = useTranslation();

  return (
    <div className="narration-row generate-button-row">
      <div className="row-label">
        <label>{t('narration.generate', 'Generate')}:</label>
      </div>
      <div className="row-content">
        <div className="pill-button-group">
          {isGenerating ? (
            <button
              className="pill-button danger cancel-btn"
              onClick={cancelGeneration}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
              {t('narration.cancel', 'Cancel Generation')}
            </button>
          ) : (
            <button
              className="pill-button primary generate-btn"
              onClick={handleGenerateNarration}
              disabled={!referenceAudio}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 5.14v14l11-7-11-7z" />
              </svg>
              {t('narration.generate', 'Generate Narration')}
            </button>
          )}

          {generationResults.length > 0 && (
            <>
              <button
                className="pill-button secondary download-all-btn"
                onClick={downloadAllAudio}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {t('narration.downloadAll', 'Download All')}
              </button>

              <button
                className="pill-button secondary"
                onClick={downloadAlignedAudio}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {t('narration.downloadAligned', 'Download Aligned')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default GenerateButton;
