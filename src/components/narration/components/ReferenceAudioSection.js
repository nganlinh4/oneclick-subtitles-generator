import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import MaterialSwitch from '../../common/MaterialSwitch';
import CustomScrollbarTextarea from '../../common/CustomScrollbarTextarea';
import '../../../styles/common/material-switch.css';
import HelpIcon from '../../common/HelpIcon';
import { showInfoToast } from '../../../utils/toastUtils';




/**
 * Reference Audio Section component
 * @param {Object} props - Component props
 * @param {Object} props.referenceAudio - Reference audio object
 * @param {boolean} props.autoRecognize - Whether to auto-recognize voice
 * @param {Function} props.setAutoRecognize - Function to set auto-recognize
 * @param {boolean} props.isRecognizing - Whether voice recognition is in progress
 * @param {string} props.referenceText - Reference text
 * @param {Function} props.setReferenceText - Function to set reference text
 * @param {Function} props.clearReferenceAudio - Function to clear reference audio
 * @param {boolean} props.isRecording - Whether recording is in progress
 * @param {boolean} props.isExtractingSegment - Whether segment extraction is in progress
 * @returns {JSX.Element} - Rendered component
 */
const ReferenceAudioSection = ({
  referenceAudio,
  autoRecognize,
  setAutoRecognize,
  isRecognizing,
  referenceText,
  setReferenceText,
  clearReferenceAudio,
  isRecording,
  isExtractingSegment
}) => {
  const { t } = useTranslation();

  // Show toast when voice recognition starts
  useEffect(() => {
    if (isRecognizing) {
      showInfoToast(t('narration.recognizing', 'Recognizing voice...'));
    }
  }, [isRecognizing, t]);

  return (
    <div className="narration-row reference-audio-row">
      <div className="row-label">
        <label>{t('narration.referenceAudio', 'Văn bản tham chiếu')}:</label>
      </div>
      <div className="row-content">
        <div className="reference-audio-container">
          {/* Reference Content Row */}
          <div className="reference-content-row">
            {/* Reference Text */}
            <div className="reference-text-wrapper">
              <CustomScrollbarTextarea
                value={referenceText}
                onChange={(e) => setReferenceText(e.target.value)}
                placeholder={t('narration.referenceTextPlaceholder', 'Enter text that matches the reference audio...')}
                rows={2}
                disabled={isRecognizing}
              />
            </div>

            {/* Auto-Recognition Switch */}
            <div className="material-switch-container">
              <MaterialSwitch
                id="auto-recognize"
                checked={autoRecognize}
                onChange={(e) => setAutoRecognize(e.target.checked)}
                disabled={isRecording || isExtractingSegment || isRecognizing}
                ariaLabel={t('narration.autoRecognize', 'Auto-recognize voice')}
                icons={true}
              />
              <span>{t('narration.autoRecognize', 'Auto-recognize voice')}</span>
              <HelpIcon title={t('narration.autoRecognizeDescription', 'Automatically transcribe audio after recording or uploading')} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReferenceAudioSection;
