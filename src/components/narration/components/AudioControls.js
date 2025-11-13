import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SERVER_URL } from '../../../config';
import ExampleAudioDropdown from './ExampleAudioDropdown';
import HelpIcon from '../../common/HelpIcon';
import LoadingIndicator from '../../common/LoadingIndicator';
import AudioPlayer from '../../common/AudioPlayer';
import { formatTime } from '../../../utils/timeFormatter';
import { showSuccessToast } from '../../../utils/toastUtils';

/**
 * Audio Controls component
 * This component now handles theme detection and passes the correct colors
 * to the WavyProgressIndicator.
 */
const AudioControls = ({
    handleFileUpload,
    fileInputRef,
    isRecording,
    isStartingRecording,
    recordingStartTime,
    startRecording,
    stopRecording,
    isAvailable,
    referenceAudio,
    clearReferenceAudio,
    onExampleSelect,
    narrationMethod,
    height = 18
}) => {
    const { t } = useTranslation();
    const [elapsed, setElapsed] = useState(0);

    // Show toast when reference audio is ready (but not when loaded from cache)
    useEffect(() => {
        if (referenceAudio && !referenceAudio.fromCache) {
            showSuccessToast(t('narration.referenceAudioReady', 'Reference audio is ready'));
        }
    }, [referenceAudio?.filename, t]);

    // Update elapsed time while recording
    useEffect(() => {
        if (isRecording && recordingStartTime) {
            setElapsed((Date.now() - recordingStartTime) / 1000);
            const id = setInterval(() => {
                setElapsed((Date.now() - recordingStartTime) / 1000);
            }, 100);
            return () => clearInterval(id);
        } else {
            setElapsed(0);
        }
    }, [isRecording, recordingStartTime]);





    const audioSrc = referenceAudio ? (referenceAudio.url || `${SERVER_URL}/api/narration/audio/${referenceAudio.filename}`) : null;

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
                            disabled={isRecording || isStartingRecording || !isAvailable}
                        >
                            <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>upload</span>
                            {t('narration.upload', 'Upload')}
                        </button>
                        <input
                            type="file"
                            ref={fileInputRef}
                            onChange={handleFileUpload}
                            accept="audio/*"
                            style={{ display: 'none' }}
                        />

                        {/* Record / Starting / Stop Button */}
                        {!isRecording && !isStartingRecording ? (
                            <button
                                className="pill-button primary"
                                onClick={startRecording}
                                disabled={!isAvailable}
                                title={t('narration.record', 'Record')}
                            >
                                <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>radio_button_checked</span>
                                {t('narration.record', 'Record')}
                            </button>
                        ) : !isRecording && isStartingRecording ? (
                            <button
                                className="pill-button primary"
                                disabled
                                title={t('narration.startingRecording', 'Starting microphone...')}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
                            >
                                <LoadingIndicator theme="light" showContainer={false} size={18} />
                            </button>
                        ) : (
                            <button
                                className="pill-button error"
                                onClick={stopRecording}
                                title={t('narration.stopRecording', 'Stop')}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
                            >
                                <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>stop</span>
                                {t('narration.stopRecording', 'Stop')} {formatTime(elapsed, 'hms_ms')}
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
                        <div className="audio-preview" style={{ height: `32px`, marginTop: '6px' }}>
                            <div className="audio-player-container primary-audio-player">
                                {audioSrc && (
                                    <AudioPlayer audioSrc={audioSrc} referenceAudio={referenceAudio} height={height} />
                                )}
                            </div>
                            <button
                                className="pill-button error clear-button"
                                onClick={clearReferenceAudio}
                                title={t('narration.clearReference', 'Clear reference audio')}
                            >
                                <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>close</span>
                            </button>

                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default AudioControls;