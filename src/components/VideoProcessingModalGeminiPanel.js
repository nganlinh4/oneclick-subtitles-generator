import { useTranslation } from 'react-i18next';
import MaterialSwitch from './common/MaterialSwitch';
import SliderWithValue from './common/SliderWithValue';
import CustomDropdown from './common/CustomDropdown';
import HelpIcon from './common/HelpIcon';
import { getFpsValue, getFpsInterval } from '../utils/fpsFormat';

/**
 * The full Gemini options UI for the video processing modal.
 *
 * Renders every Gemini control group: frame rate + media resolution, model +
 * max duration, prompt preset + target language, analysis rules + segment
 * delay, surrounding context + coverage, and auto-split + max words. Pure
 * component — all state and option builders are supplied via props.
 */
const VideoProcessingModalGeminiPanel = ({
    videoFile,
    selectedModel,
    setSelectedModel,
    fps,
    setFps,
    mediaResolution,
    setMediaResolution,
    resolutionOptions,
    modelOptions,
    maxDurationPerRequest,
    setMaxDurationPerRequest,
    retryLock,
    isVercelMode,
    inlineExtraction,
    selectedSegment,
    selectedPromptPreset,
    setSelectedPromptPreset,
    getPromptPresetOptions,
    customLanguage,
    setCustomLanguage,
    transcriptionRulesAvailable,
    useTranscriptionRules,
    setUseTranscriptionRules,
    segmentProcessingDelay,
    setSegmentProcessingDelay,
    outsideContextAvailable,
    useOutsideResultsContext,
    setUseOutsideResultsContext,
    outsideContextRange,
    setOutsideContextRange,
    autoSplitSubtitles,
    handleAutoSplitToggle,
    maxWordsPerSubtitle,
    setMaxWordsPerSubtitle,
}) => {
    const { t } = useTranslation();

    return (
        <>
            {/* Normal (Gemini) UI */}
            {/* Frame Rate and Media Resolution Combined - Disabled for audio files */}
            <div className="option-group">
                <div className="combined-options-row">
                    {/* Frame Rate Slider */}
                    <div className="combined-option-half">
                        <div className="label-with-help">
                            <label>
                                {t('processing.frameRate', 'Frame Rate')}
                                <span className="label-subtitle">({getFpsInterval(fps, t)})</span>
                            </label>
                            {videoFile?.type?.startsWith('audio/') &&
                                <HelpIcon title={t('processing.audioFpsDisabled', 'FPS settings are not applicable for audio files')} />}
                        </div>
                        <div>
                            <SliderWithValue
                                value={fps}
                                onChange={(v) => setFps(parseFloat(v))}
                                min={0.25}
                                max={5}
                                step={0.25}
                                orientation="Horizontal"
                                size="XSmall"
                                state={videoFile?.type?.startsWith('audio/') ? 'Disabled' : 'Enabled'}
                                className="fps-slider"
                                id="fps-slider"
                                ariaLabel={t('processing.frameRate', 'Frame Rate')}
                                defaultValue={0.25}
                                formatValue={(v) => getFpsValue(v)}
                                disabled={videoFile?.type?.startsWith('audio/')}
                            />
                        </div>
                    </div>

                    {/* Media Resolution */}
                    <div className="combined-option-half">
                        <div className="label-with-help">
                            <label>{t('processing.mediaResolution', 'Media Resolution')}</label>
                            <HelpIcon title={videoFile?.type?.startsWith('audio/')
                                ? t('processing.audioResolutionDisabled', 'Resolution settings are not applicable for audio files')
                                : t('processing.mediaResolutionHelp', "64 or 256 tokens cannot be mapped to an exact resolution; this reflects Gemini's proprietary video information extraction method.")
                            } />
                        </div>
                        <CustomDropdown
                            value={mediaResolution}
                            onChange={(value) => setMediaResolution(value)}
                            options={resolutionOptions.map(option => ({
                                value: option.value,
                                label: option.label
                            }))}
                            placeholder={t('processing.selectResolution', 'Select Resolution')}
                            disabled={videoFile?.type?.startsWith('audio/')}
                            style={{ maxWidth: '250px' }}
                        />
                    </div>
                </div>
            </div>

            {/* Model and Max Duration Combined Row */}
            <div className="option-group">
                <div className="combined-options-row">
                    {/* Left half: Model Selection */}
                    <div className="combined-option-half">
                        <div className="label-with-help">
                            <label>{t('processing.model', 'Model')}</label>
                            <HelpIcon title={t('processing.modelHelp', 'Choose a catalog-verified model that accepts audio or video input.')} />
                        </div>
                        <CustomDropdown
                            value={selectedModel}
                            onChange={(value) => setSelectedModel(value)}
                            options={modelOptions.map(option => ({
                                value: option.value,
                                label: option.label,
                                disabled: option.disabled
                            }))}
                            placeholder={t('processing.selectModel', 'Select Model')}
                            style={{ maxWidth: '250px' }}
                        />
                    </div>

                    {/* Right half: Max duration per request */}
                    <div className="combined-option-half">
                        <div className={`label-with-help ${retryLock ? 'disabled' : ''}`} aria-disabled={retryLock ? 'true' : 'false'}>
                            <label>{t('processing.maxDurationPerRequest', 'Max duration per request')}</label>
                            <HelpIcon title={(() => {
                                if (videoFile?.type?.startsWith('audio/')) {
                                    if (isVercelMode) {
                                        return t('processing.maxDurationAudioVercel', 'Parallel processing is not available for audio files in Vercel version. Audio files must be processed as a single request.');
                                    } else if (!inlineExtraction) {
                                        return t('processing.maxDurationAudioNewMethod', 'Parallel processing is not available for audio files with the new method. Use the old method for audio parallel processing.');
                                    }
                                }
                                return t('processing.maxDurationPerRequestDesc', 'Maximum duration for each Gemini request. Longer segments will be split into parallel requests.');
                            })()} />
                        </div>
                        <div>
                            <SliderWithValue
                                value={maxDurationPerRequest}
                                onChange={(v) => setMaxDurationPerRequest(parseInt(v))}
                                min={1}
                                max={20}
                                step={1}
                                orientation="Horizontal"
                                size="XSmall"
                                state={(() => {
                                    if (retryLock) return 'Disabled';
                                    if (videoFile?.type?.startsWith('audio/')) {
                                        // In Vercel mode, disable slider for all audio
                                        if (isVercelMode) return 'Disabled';
                                        // In non-Vercel mode, disable slider for audio with new method
                                        if (!inlineExtraction) return 'Disabled';
                                    }
                                    return 'Enabled';
                                })()}
                                id="max-duration-slider"
                                ariaLabel={t('processing.maxDurationPerRequest', 'Max duration per request')}
                                defaultValue={10}
                                formatValue={(v) => (
                                    <>
                                        {t('processing.minutesValue', '{{value}} minutes', { value: v })}
                                        {selectedSegment && (() => {
                                            const segmentDuration = (selectedSegment.end - selectedSegment.start) / 60;
                                            const numRequests = Math.ceil(segmentDuration / Number(v || 1));
                                            return numRequests > 1 ? (
                                                <span className="parallel-info">{' '}({t('processing.parallelRequestsInfo', 'Will split into {{count}} parallel requests', { count: numRequests })})</span>
                                            ) : null;
                                        })()}
                                    </>
                                )}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Prompt Preset and Target Language Row */}
            <div className="option-group">
                <div className="combined-options-row">
                    {/* Left: Prompt Preset Selection */}
                    <div className="combined-option-half">
                        <label>{t('processing.promptPreset', 'Prompt Preset')}</label>
                        <CustomDropdown
                            value={selectedPromptPreset}
                            onChange={(value) => setSelectedPromptPreset(value)}
                            options={getPromptPresetOptions().map(option => {
                                // Create SVG icon based on preset type
                                let IconComponent = null;

                                if (option.id === 'settings') {
                                    // Settings/sliders icon for "Prompt from Settings"
                                    IconComponent = () => (
                                        <span className="material-symbols-rounded" style={{ fontSize: '16px', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>settings</span>
                                    );
                                } else if (option.id === 'timing-generation') {
                                    // Clock/timing icon for timing generation
                                    IconComponent = () => (
                                        <span className="material-symbols-rounded" style={{ fontSize: '16px', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>schedule</span>
                                    );
                                } else if (option.isUserPreset) {
                                    // User icon for user presets
                                    IconComponent = () => (
                                        <span className="material-symbols-rounded" style={{ fontSize: '16px', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>person</span>
                                    );
                                } else {
                                    // Built-in preset icons
                                    switch (option.id) {
                                        case 'general':
                                            IconComponent = () => (
                                                <span className="material-symbols-rounded" style={{ fontSize: '16px', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>grid_view</span>
                                            );
                                            break;
                                        case 'extract-text':
                                            IconComponent = () => (
                                                <span className="material-symbols-rounded" style={{ fontSize: '16px', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>description</span>
                                            );
                                            break;
                                        case 'focus-lyrics':
                                            IconComponent = () => (
                                                <span className="material-symbols-rounded" style={{ fontSize: '16px', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>music_note</span>
                                            );
                                            break;
                                        case 'describe-video':
                                            IconComponent = () => (
                                                <span className="material-symbols-rounded" style={{ fontSize: '16px', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>videocam</span>
                                            );
                                            break;
                                        case 'translate-directly':
                                            IconComponent = () => (
                                                <span className="material-symbols-rounded" style={{ fontSize: '16px', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>language</span>
                                            );
                                            break;
                                        case 'chaptering':
                                            IconComponent = () => (
                                                <span className="material-symbols-rounded" style={{ fontSize: '16px', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>bookmark</span>
                                            );
                                            break;
                                        case 'diarize-speakers':
                                            IconComponent = () => (
                                                <span className="material-symbols-rounded" style={{ fontSize: '16px', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>group</span>
                                            );
                                            break;
                                        default:
                                            // Default clipboard icon
                                            IconComponent = () => (
                                                <span className="material-symbols-rounded" style={{ fontSize: '16px', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>content_copy</span>
                                            );
                                    }
                                }

                                return {
                                    value: option.id,
                                    label: IconComponent ? (
                                        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                                            <IconComponent />
                                            {option.title}
                                        </span>
                                    ) : option.title,
                                    disabled: option.disabled
                                };
                            })}
                            placeholder={t('processing.selectPreset', 'Select Preset')}
                        />
                        <p className="option-description">
                            {(() => {
                                const selectedOption = getPromptPresetOptions().find(opt => opt.id === selectedPromptPreset);
                                return selectedOption?.description || '';
                            })()}
                        </p>
                    </div>

                    {/* Right: Target Language (only when translate-directly is selected) */}
                    {selectedPromptPreset === 'translate-directly' && (
                        <div className="combined-option-half">
                            <label>{t('processing.targetLanguage', 'Target Language')}</label>
                            <input
                                type="text"
                                value={customLanguage}
                                onChange={(e) => setCustomLanguage(e.target.value)}
                                placeholder={t('processing.targetLanguagePlaceholder', 'Enter target language (e.g., Vietnamese, Spanish)')}
                                className="language-input"
                            />
                        </div>
                    )}
                </div>
            </div>

            {/* Analysis Rules and Segment Processing Delay Row */}
            <div className="option-group">
                <div className="combined-options-row">
                    {/* Left: Analysis Rules */}
                    <div className="combined-option-half">
                        <div className="label-with-help">
                            <label>{t('processing.analysisRules', 'Analysis Rules')}</label>
                            <HelpIcon title={transcriptionRulesAvailable
                                ? t('processing.useTranscriptionRulesDesc', 'Include context, terminology, and formatting rules from video analysis in the prompt. When enabled, these analysis rules derived from video content will be embedded in the prompt to improve subtitle quality and formatting consistency. Note: This may sometimes cause timing shifts for subtitles.')
                                : t('processing.noAnalysisAvailable', 'Please create analysis by pressing "Add analysis" button')
                            } />
                        </div>
                        <div className="material-switch-container">
                            <MaterialSwitch
                                id="use-transcription-rules"
                                checked={useTranscriptionRules && transcriptionRulesAvailable}
                                onChange={(e) => setUseTranscriptionRules(e.target.checked)}
                                disabled={!transcriptionRulesAvailable}
                                ariaLabel={t('processing.useTranscriptionRules', 'Use transcription rules from analysis')}
                                icons={true}
                            />
                            <label htmlFor="use-transcription-rules" className="material-switch-label">
                                {t('processing.useTranscriptionRules', 'Use transcription rules from analysis')}
                            </label>
                        </div>
                    </div>

                    {/* Right: Segment Processing Delay */}
                    <div className="combined-option-half">
                        <div className="label-with-help">
                            <label>{t('processing.segmentProcessingDelay', 'Segment processing delay')}</label>
                            <HelpIcon title={(() => {
                                if (selectedSegment) {
                                    const segmentDuration = (selectedSegment.end - selectedSegment.start) / 60;
                                    const numRequests = Math.ceil(segmentDuration / Number(maxDurationPerRequest || 1));
                                    if (numRequests <= 1) {
                                        return t('processing.delayOnlyWithParallel', 'Chỉ khả dụng khi có nhiều phân đoạn');
                                    }
                                }
                                return t('processing.segmentProcessingDelayDesc', '0 = all segments at once (fastest). Set higher values to process segments sequentially (e.g., 10 seconds delay between each segment). This will help ease the penalty of rate limits as well as less lags on weaker computers');
                            })()} />
                        </div>
                        <div>
                            <SliderWithValue
                                value={segmentProcessingDelay}
                                onChange={(v) => setSegmentProcessingDelay(parseInt(v))}
                                min={0}
                                max={60}
                                step={1}
                                orientation="Horizontal"
                                size="XSmall"
                                state={(() => {
                                    // Enable delay slider only when parallel requests are triggered
                                    if (selectedSegment) {
                                        const segmentDuration = (selectedSegment.end - selectedSegment.start) / 60;
                                        const numRequests = Math.ceil(segmentDuration / Number(maxDurationPerRequest || 1));
                                        if (numRequests > 1) return 'Enabled';
                                    }
                                    return 'Disabled';
                                })()}
                                id="segment-processing-delay-slider"
                                ariaLabel={t('processing.segmentProcessingDelay', 'Segment processing delay')}
                                defaultValue={0}
                                formatValue={(v) => (
                                    <>
                                        {v === 0
                                            ? t('processing.simultaneousProcessing', 'Simultaneous')
                                            : t('processing.secondsDelay', '{{value}}s sleep', { value: v })
                                        }
                                    </>
                                )}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Surrounding context and Context coverage in left column */}
            <div className="option-group">
                <div className="combined-options-row">
                    {/* Left half: Outside context switch */}
                    <div className="combined-option-half">
                        <div className="label-with-help">
                            <label>{t('processing.notifyOutsideResults', 'Surrounding context')}</label>
                            <HelpIcon title={outsideContextAvailable
                                ? t('processing.notifyOutsideResultsDesc', 'Include immediately-before/after subtitles outside the selected range to improve consistency')
                                : t('processing.noOutsideContext', 'No outside subtitles available (switch disabled)')
                            } />
                        </div>
                        <div className="material-switch-container">
                            <MaterialSwitch
                                id="use-outside-context"
                                checked={useOutsideResultsContext && outsideContextAvailable}
                                onChange={(e) => setUseOutsideResultsContext(e.target.checked)}
                                disabled={!outsideContextAvailable}
                                ariaLabel={t('processing.notifyOutsideResults', 'Include surrounding subtitles as context')}
                                icons={true}
                            />
                            <label htmlFor="use-outside-context" className="material-switch-label">
                                {t('processing.notifyOutsideResults', 'Include surrounding subtitles as context')}
                            </label>
                        </div>
                    </div>

                    {/* Right half: Context range slider (1-20, last = Unlimited) */}
                    <div className="combined-option-half">
                        <div className="label-with-help">
                            <label>{t('processing.outsideContextRange', 'Context coverage')}</label>
                            <HelpIcon title={t('processing.outsideContextRangeDesc', 'How many subtitles before/after to include as context. The last value is Unlimited.')} />
                        </div>
                        <div>
                            <SliderWithValue
                                value={outsideContextRange}
                                onChange={(v) => setOutsideContextRange(Number(v))}
                                min={1}
                                max={21}
                                step={1}
                                orientation="Horizontal"
                                size="XSmall"
                                state={outsideContextAvailable && useOutsideResultsContext ? 'Enabled' : 'Disabled'}
                                id="outside-context-range"
                                ariaLabel={t('processing.outsideContextRange', 'Context coverage')}
                                disabled={!outsideContextAvailable || !useOutsideResultsContext}
                                showValueBadge={true}
                                valueBadgeFormatter={(v) => (Math.round(Number(v)) >= 21 ? t('processing.unlimited', 'Unlimited') : Math.round(Number(v)))}
                                defaultValue={5}
                                formatValue={(v) => (Number(v) === 21 ? t('processing.unlimited', 'Unlimited') : t('processing.linesCount', '{{count}} lines', { count: Number(v) }))}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Auto-split subtitles and Max words per subtitle */}
            <div className="option-group">
                <div className="combined-options-row">
                    {/* Left half: Auto-split switch */}
                    <div className="combined-option-half">
                        <div className="label-with-help">
                            <label>{t('processing.autoSplitSubtitles', 'Auto-split subtitles')}</label>
                            <HelpIcon title={t('processing.autoSplitHelp', 'Automatically split long subtitles into smaller segments for better readability. The splitting happens in real-time during streaming.')} />
                        </div>
                        <div className="material-switch-container">
                            <MaterialSwitch
                                id="auto-split-subtitles"
                                checked={autoSplitSubtitles}
                                onChange={(e) => handleAutoSplitToggle(e.target.checked)}
                                ariaLabel={t('processing.autoSplitSubtitles', 'Auto-split subtitles')}
                                icons={true}
                            />
                            <label htmlFor="auto-split-subtitles" className="material-switch-label">
                                {t('processing.enableAutoSplit', 'Enable auto-splitting')}
                            </label>
                        </div>
                    </div>

                    {/* Right half: Max words slider (always visible, disabled when switch is off) */}
                    <div className="combined-option-half">
                        <div className="label-with-help">
                            <label>{t('processing.maxWordsPerSubtitle', 'Max words per subtitle')}</label>
                            <HelpIcon title={t('processing.maxWordsHelp', 'Maximum number of words allowed per subtitle. Longer subtitles will be split evenly.')} />
                        </div>
                        <div>
                            <SliderWithValue
                                value={maxWordsPerSubtitle}
                                onChange={(v) => setMaxWordsPerSubtitle(parseInt(v))}
                                min={1}
                                max={30}
                                step={1}
                                orientation="Horizontal"
                                size="XSmall"
                                state={autoSplitSubtitles ? 'Enabled' : 'Disabled'}
                                className="max-words-slider"
                                id="max-words-slider"
                                ariaLabel={t('processing.maxWordsPerSubtitle', 'Maximum words per subtitle')}
                                disabled={!autoSplitSubtitles}
                                showValueBadge={true}
                                valueBadgeFormatter={(v) => Math.round(Number(v))}
                                defaultValue={12}
                                formatValue={(v) => t('processing.wordsLimit', '{{count}} {{unit}}', {
                                    count: Number(v),
                                    unit: Number(v) === 1 ? t('processing.word', 'word') : t('processing.words', 'words')


                                })}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
};

export default VideoProcessingModalGeminiPanel;
