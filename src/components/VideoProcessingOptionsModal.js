import React from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import '../styles/VideoProcessingOptionsModal.css';
import { formatTime } from '../utils/timeFormatter';
import CloseButton from './common/CloseButton';
import AsrProcessingOptions from './AsrProcessingOptions';
import TranscriptionMethodSelectionOverlay from './TranscriptionMethodSelectionOverlay';
import VideoProcessingModalMethodSelector from './VideoProcessingModalMethodSelector';
import VideoProcessingModalGeminiPanel from './VideoProcessingModalGeminiPanel';
import useVideoProcessingState from './useVideoProcessingState';

// Supported languages for Parakeet with alphabetical color groups.
// Static data — defined at module scope so it isn't re-allocated on every render.
const parakeetLanguages = [
    { name: 'Bulgarian', group: 'a-f' }, { name: 'Croatian', group: 'a-f' }, { name: 'Czech', group: 'a-f' },
    { name: 'Danish', group: 'a-f' }, { name: 'Dutch', group: 'a-f' }, { name: 'English', group: 'a-f' },
    { name: 'Estonian', group: 'a-f' }, { name: 'Finnish', group: 'a-f' }, { name: 'French', group: 'a-f' },
    { name: 'German', group: 'g-l' }, { name: 'Greek', group: 'g-l' }, { name: 'Hungarian', group: 'g-l' },
    { name: 'Italian', group: 'g-l' }, { name: 'Latvian', group: 'g-l' }, { name: 'Lithuanian', group: 'g-l' },
    { name: 'Maltese', group: 'm-r' }, { name: 'Polish', group: 'm-r' }, { name: 'Portuguese', group: 'm-r' },
    { name: 'Romanian', group: 'm-r' }, { name: 'Russian', group: 'm-r' }, { name: 'Slovak', group: 's-z' },
    { name: 'Slovenian', group: 's-z' }, { name: 'Spanish', group: 's-z' }, { name: 'Swedish', group: 's-z' },
    { name: 'Ukrainian', group: 's-z' }
];

/**
 * Modal for selecting video processing options after timeline segment selection.
 *
 * All state, persistence, and derived values live in useVideoProcessingState; this
 * component wires those into the header method selector, the Parakeet/Gemini option
 * panels, and the footer (token usage / supported languages / start button).
 */
const VideoProcessingOptionsModal = ({
    isOpen,
    onClose,
    onProcess,
    selectedSegment, // { start: number, end: number } in seconds
    isUploading = false,
    videoFile = null, // Optional video file for real token counting
    userProvidedSubtitles = '', // User-provided subtitles text
    useUserProvidedSubtitles = false, // Whether user-provided subtitles are enabled
    subtitlesData = null, // Current subtitles on the timeline
    onSelectedSegmentChange = null // Callback to update selectedSegment in parent
}) => {
    const { t } = useTranslation();

    const {
        modalRef,
        contentRef,
        languagesRef,
        isVercelMode,
        descriptor,
        engineAvailable,
        method,
        setMethod,
        showMethodSelection,
        setShowMethodSelection,
        inlineExtraction,
        retryLock,
        asrStrategy,
        setAsrStrategy,
        asrMaxChars,
        setAsrMaxChars,
        asrMaxWords,
        setAsrMaxWords,
        asrPreserveSentences,
        setAsrPreserveSentences,
        asrMaxDurationPerRequest,
        setAsrMaxDurationPerRequest,
        asrLanguage,
        setAsrLanguage,
        fps,
        setFps,
        mediaResolution,
        setMediaResolution,
        selectedModel,
        setSelectedModel,
        selectedPromptPreset,
        setSelectedPromptPreset,
        customLanguage,
        setCustomLanguage,
        useTranscriptionRules,
        setUseTranscriptionRules,
        transcriptionRulesAvailable,
        useOutsideResultsContext,
        setUseOutsideResultsContext,
        outsideContextAvailable,
        outsideContextRange,
        setOutsideContextRange,
        maxDurationPerRequest,
        setMaxDurationPerRequest,
        segmentProcessingDelay,
        setSegmentProcessingDelay,
        autoSplitSubtitles,
        handleAutoSplitToggle,
        maxWordsPerSubtitle,
        setMaxWordsPerSubtitle,
        resolutionOptions,
        modelOptions,
        getPromptPresetOptions,
        selectedModelData,
        isWithinLimit,
        realTokenCount,
        displayTokens,
        isCountingTokens,
        handleProcess,
    } = useVideoProcessingState({
        isOpen,
        onClose,
        isUploading,
        videoFile,
        userProvidedSubtitles,
        useUserProvidedSubtitles,
        subtitlesData,
        onSelectedSegmentChange,
        selectedSegment,
        onProcess,
    });

    if (!isOpen) return null;

    // For local ASR methods, engine availability gates the options panel and the Start button.
    const isAsrPanel = descriptor.optionsPanel === 'asr';
    const asrPanelDisabled = isAsrPanel && !engineAvailable;

    return ReactDOM.createPortal(
        <>
            <TranscriptionMethodSelectionOverlay
                isOpen={showMethodSelection}
                onClose={() => {
                    setShowMethodSelection(false);
                }}
                onCloseAndHideModal={() => {
                    setShowMethodSelection(false);
                    onClose();
                }}
                onMethodSelect={(method) => {
                    setMethod(method);
                    localStorage.setItem('has_seen_transcription_method_selection', 'true');
                    setShowMethodSelection(false);
                }}
            />
            {!showMethodSelection && (
                <div className="video-processing-modal-overlay">
                    <div
                        className="video-processing-modal"
                        ref={modalRef}
                    >
                        <div className="modal-header">
                            <div className="header-content">
                                <h3>
                                    {t('processing.generateForRange', 'Generate/update subtitles for range:')}
                                    <span className="segment-time">
                                        {formatTime(selectedSegment?.start || 0, 'hms')} - {formatTime(selectedSegment?.end || 0, 'hms')}
                                        {' '}({Math.round((selectedSegment?.end || 0) - (selectedSegment?.start || 0))}s)
                                    </span>
                                </h3>
                                <VideoProcessingModalMethodSelector
                                    isVercelMode={isVercelMode}
                                    method={method}
                                    setMethod={setMethod}
                                    retryLock={retryLock}
                                    onReopenSelection={() => setShowMethodSelection(true)}
                                />
                            </div>
                            <CloseButton onClick={onClose} variant="modal" size="medium" />
                        </div>

                        <div className="modal-content" ref={contentRef}>
                            {/* Two-column grid for options */}
                            <div className="modal-content-grid">
                                {isAsrPanel ? (
                                    <AsrProcessingOptions
                                        strategy={asrStrategy}
                                        setStrategy={setAsrStrategy}
                                        maxDurationPerRequest={asrMaxDurationPerRequest}
                                        setMaxDurationPerRequest={setAsrMaxDurationPerRequest}
                                        maxChars={asrMaxChars}
                                        setMaxChars={setAsrMaxChars}
                                        maxWords={asrMaxWords}
                                        setMaxWords={setAsrMaxWords}
                                        preserveSentences={asrPreserveSentences}
                                        setPreserveSentences={setAsrPreserveSentences}
                                        language={asrLanguage}
                                        setLanguage={setAsrLanguage}
                                        supportsLanguage={!!descriptor.capabilities?.language}
                                        selectedSegment={selectedSegment}
                                        disabled={asrPanelDisabled}
                                        engineName={descriptor.labelDefault}
                                    />
                                ) : (
                                    <VideoProcessingModalGeminiPanel
                                        videoFile={videoFile}
                                        selectedModel={selectedModel}
                                        setSelectedModel={setSelectedModel}
                                        fps={fps}
                                        setFps={setFps}
                                        mediaResolution={mediaResolution}
                                        setMediaResolution={setMediaResolution}
                                        resolutionOptions={resolutionOptions}
                                        modelOptions={modelOptions}
                                        maxDurationPerRequest={maxDurationPerRequest}
                                        setMaxDurationPerRequest={setMaxDurationPerRequest}
                                        retryLock={retryLock}
                                        isVercelMode={isVercelMode}
                                        inlineExtraction={inlineExtraction}
                                        selectedSegment={selectedSegment}
                                        selectedPromptPreset={selectedPromptPreset}
                                        setSelectedPromptPreset={setSelectedPromptPreset}
                                        getPromptPresetOptions={getPromptPresetOptions}
                                        customLanguage={customLanguage}
                                        setCustomLanguage={setCustomLanguage}
                                        transcriptionRulesAvailable={transcriptionRulesAvailable}
                                        useTranscriptionRules={useTranscriptionRules}
                                        setUseTranscriptionRules={setUseTranscriptionRules}
                                        segmentProcessingDelay={segmentProcessingDelay}
                                        setSegmentProcessingDelay={setSegmentProcessingDelay}
                                        outsideContextAvailable={outsideContextAvailable}
                                        useOutsideResultsContext={useOutsideResultsContext}
                                        setUseOutsideResultsContext={setUseOutsideResultsContext}
                                        outsideContextRange={outsideContextRange}
                                        setOutsideContextRange={setOutsideContextRange}
                                        autoSplitSubtitles={autoSplitSubtitles}
                                        handleAutoSplitToggle={handleAutoSplitToggle}
                                        maxWordsPerSubtitle={maxWordsPerSubtitle}
                                        setMaxWordsPerSubtitle={setMaxWordsPerSubtitle}
                                    />
                                )}

                            </div>
                        </div>



                        <div className="modal-footer">
                            <div className="footer-content">
                                {/* Token Usage Info (engines that support token counting — Gemini only) */}
                                {descriptor.capabilities.tokenCounting && (
                                    <div className="footer-token-info">
                                        <div className="token-usage">
                                            <span className="token-label">
                                                {isCountingTokens
                                                    ? t('processing.countingTokens', 'Counting Tokens...')
                                                    : realTokenCount !== null
                                                        ? t('processing.actualTokens', 'Actual Token Usage')
                                                        : t('processing.estimatedTokens', 'Estimated Token Usage')
                                                }:
                                            </span>
                                            <span className={`token-count ${isWithinLimit ? 'within-limit' : 'exceeds-limit'}`}>
                                                {displayTokens.toLocaleString()} / {selectedModelData?.maxTokens.toLocaleString()} tokens
                                            </span>
                                        </div>
                                    </div>
                                )}

                                {/* Supported-languages strip (engines that advertise it, e.g. Parakeet) */}
                                {descriptor.supportedLanguagesBadges && (
                                    <div className="footer-languages-info">
                                        <div className="supported-languages-label">{t('processing.supportedLanguages', 'Supported languages')}</div>
                                        <div
                                            className="languages-badges"
                                            ref={languagesRef}
                                        >
                                            {parakeetLanguages.map(lang => <span key={lang.name} className={`language-badge language-badge-${lang.group}`}>{lang.name}</span>)}
                                        </div>
                                    </div>
                                )}

                                <div className="footer-buttons">
                                    <button
                                        className="process-btn"
                                        onClick={handleProcess}
                                        disabled={isUploading || (descriptor.capabilities.tokenCounting && !isWithinLimit) || asrPanelDisabled}
                                    >
                                        {isUploading
                                            ? t('processing.waitingForUpload', 'Waiting for upload...')
                                            : t('processing.startProcessing', 'Start Processing')
                                        }
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>,
        document.body
    );
};

export default VideoProcessingOptionsModal;
