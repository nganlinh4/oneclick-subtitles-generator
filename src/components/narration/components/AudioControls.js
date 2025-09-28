import React from 'react';
import { useTranslation } from 'react-i18next';
import { SERVER_URL } from '../../../config';
import ExampleAudioDropdown from './ExampleAudioDropdown';
import HelpIcon from '../../common/HelpIcon';


/**
 * Audio Controls component
 * @param {Object} props - Component props
 * @param {Function} props.handleFileUpload - Function to handle file upload
 * @param {React.RefObject} props.fileInputRef - Reference to file input
 * @param {boolean} props.isRecording - Whether recording is in progress
 * @param {Function} props.startRecording - Function to start recording
 * @param {Function} props.stopRecording - Function to stop recording
 * @param {boolean} props.isAvailable - Whether narration service is available
 * @param {Object} props.referenceAudio - Reference audio object
 * @param {Function} props.clearReferenceAudio - Function to clear reference audio
 * @param {Function} props.onExampleSelect - Function to handle example audio selection
 * @param {string} props.narrationMethod - Current narration method (f5tts, chatterbox, etc.)
 * @returns {JSX.Element} - Rendered component
 */

const AudioControls = ({
  handleFileUpload,
  fileInputRef,
  isRecording,
  startRecording,
  stopRecording,
  isAvailable,
  referenceAudio,
  clearReferenceAudio,
  onExampleSelect,
  narrationMethod
}) => {
  const { t } = useTranslation();

  return (
    <div className="narration-row audio-controls-row">
      <div className="row-label">
        <label>
          {narrationMethod === 'f5tts' && (
            <HelpIcon
              title={t('narration.audioControlsHelp', 'Use reference audio <12s and leave proper silence space (e.g. 1s) at the end. Otherwise there is a risk of truncating in the middle of word')}
              size={16}
              style={{ display: 'inline-flex', marginRight: '8px', verticalAlign: 'middle' }}
            />
          )}
          {t('narration.audioControls', 'Âm thanh tham chiếu')}:
        </label>
      </div>
      <div className="row-content">
        <div className="audio-controls-container">
          <div className="audio-controls">
            {/* Upload Button */}
            <button
              className="pill-button primary"
              onClick={() => fileInputRef.current.click()}
              disabled={isRecording || !isAvailable}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              {t('narration.upload', 'Upload')}
            </button>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept="audio/*"
              style={{ display: 'none' }}
            />

            {/* Record Button */}
            {!isRecording ? (
              <button
                className="pill-button primary"
                onClick={startRecording}
                disabled={!isAvailable}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="6" fill="currentColor" />
                </svg>
                {t('narration.record', 'Record')}
              </button>
            ) : (
              <button
                className="pill-button error"
                onClick={stopRecording}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="6" width="12" height="12" fill="currentColor" />
                </svg>
                {t('narration.stopRecording', 'Stop')}
              </button>
            )}

            {/* Use Example Button */}
            <ExampleAudioDropdown
              onExampleSelect={onExampleSelect}
              disabled={isRecording || !isAvailable}
            />
          </div>

          {/* Audio Preview */}
          {referenceAudio && (
            <div className="audio-preview">
              <div className="audio-player-container">
                {referenceAudio.url ? (
                  <audio
                    controls
                    src={referenceAudio.url}
                    className="audio-player"
                    tabIndex="-1"
                  >
                    {t('narration.audioNotSupported', 'Your browser does not support the audio element.')}
                  </audio>
                ) : referenceAudio.filename ? (
                  <audio
                    controls
                    src={`${SERVER_URL}/api/narration/audio/${referenceAudio.filename}`}
                    className="audio-player"
                    tabIndex="-1"
                  >
                    {t('narration.audioNotSupported', 'Your browser does not support the audio element.')}
                  </audio>
                ) : (
                  <div className="audio-status-container">
                    <div className="status-message success">
                      <span className="status-icon">✓</span>
                      {t('narration.referenceAudioReady', 'Reference audio is ready')}
                    </div>
                  </div>
                )}
              </div>
              <button
                className="pill-button error clear-button"
                onClick={clearReferenceAudio}
                title={t('narration.clearReference', 'Clear reference audio')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AudioControls;
