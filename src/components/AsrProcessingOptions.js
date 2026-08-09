import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from './common/SliderWithValue';
import CustomDropdown from './common/CustomDropdown';
import HelpIcon from './common/HelpIcon';
import MaterialSwitch from './common/MaterialSwitch';
import { getLanguageOptions } from '../utils/languageUtils';

/**
 * Shared options panel for ALL local ASR engines (Parakeet + the catalog engines). Generalized from
 * the former ParakeetProcessingOptions: segmentation (strategy / preserve-sentences / max words / max
 * chars / max duration) for every engine, plus a capability-gated forced-language picker.
 *
 * Layout mirrors the Gemini panel exactly so the spacing/rhythm match: a 2-column grid of `.option-group`
 * cells, each holding a `.combined-options-row` of up to two controls. The visible controls are emitted
 * in a fixed order and chunked into pairs — the only control that can land unpaired is the max-duration
 * slider (always last), which reads fine at full width. Reuses the existing `processing.parakeet*` i18n
 * keys so vi/ko stay translated.
 */
const AsrProcessingOptions = ({
    strategy,
    setStrategy,
    maxDurationPerRequest,
    setMaxDurationPerRequest,
    maxChars,
    setMaxChars,
    maxWords,
    setMaxWords,
    preserveSentences,
    setPreserveSentences,
    language,
    setLanguage,
    supportsLanguage = false,
    selectedSegment,
    disabled,
    engineName,
}) => {
    const { t } = useTranslation();

    const languageOptions = useMemo(() => ([
        { value: 'auto', label: t('processing.languageAutoDetect', 'Auto-detect') },
        ...getLanguageOptions().map(({ code, name }) => ({ value: code, label: name })),
    ]), [t]);

    const wordsSlider = (id, ariaLabel) => (
        <SliderWithValue
            value={maxWords}
            onChange={(v) => setMaxWords(parseInt(v))}
            min={1}
            max={30}
            step={1}
            orientation="Horizontal"
            size="XSmall"
            state={'Enabled'}
            id={id}
            ariaLabel={ariaLabel}
            defaultValue={7}
            showValueBadge={true}
            valueBadgeFormatter={(v) => Math.round(Number(v))}
            formatValue={(v) => t('processing.wordsLimit', '{{count}} {{unit}}', {
                count: Number(v),
                unit: Number(v) === 1 ? t('processing.word', 'word') : t('processing.words', 'words'),
            })}
        />
    );

    // --- Each control is a self-contained `.combined-option-half`, emitted in a fixed order. ---
    const halves = [];

    if (supportsLanguage) {
        halves.push(
            <div className="combined-option-half" key="language">
                <div className="label-with-help">
                    <label>{t('processing.asrLanguage', 'Language')}</label>
                    <HelpIcon title={t('processing.asrLanguageHelp', 'Force a transcription language, or leave on Auto-detect.')} />
                </div>
                <CustomDropdown
                    value={language || 'auto'}
                    onChange={(value) => setLanguage(value)}
                    options={languageOptions}
                    placeholder={t('processing.asrLanguage', 'Language')}
                    style={{ maxWidth: '250px' }}
                />
            </div>
        );
    }

    halves.push(
        <div className="combined-option-half" key="splitting">
            <label>{t('processing.parakeetSplittingMethod', 'Splitting method')}</label>
            <CustomDropdown
                value={strategy}
                onChange={(value) => setStrategy(value)}
                options={[
                    { value: 'sentence', label: t('processing.parakeetStrategySentence', 'Split by sentence') },
                    { value: 'word', label: t('processing.parakeetStrategyWord', 'Split by word count') },
                    { value: 'char', label: t('processing.parakeetStrategyChar', 'Split by approximate character count') },
                ]}
                placeholder={t('processing.selectStrategy', 'Select strategy')}
                style={{ maxWidth: '250px' }}
            />
        </div>
    );

    if (strategy === 'sentence') {
        halves.push(
            <div className="combined-option-half" key="preserve">
                <div className="label-with-help">
                    <label>{t('processing.parakeetPreserveSentences', 'Preserve full sentences')}</label>
                    <HelpIcon title={t('processing.parakeetPreserveSentencesHelp', 'When enabled, full sentences are preserved. When disabled, long sentences are split evenly by word count.')} />
                </div>
                <div className="material-switch-container">
                    <MaterialSwitch
                        id="asr-preserve-sentences"
                        checked={preserveSentences}
                        onChange={(e) => setPreserveSentences(e.target.checked)}
                        ariaLabel={t('processing.parakeetPreserveSentences', 'Preserve full sentences')}
                        icons={true}
                    />
                </div>
            </div>
        );
    }

    if ((strategy === 'sentence' && !preserveSentences) || strategy === 'word') {
        const isWordStrategy = strategy === 'word';
        halves.push(
            <div className="combined-option-half" key="maxWords">
                <div className="label-with-help">
                    <label>{isWordStrategy
                        ? t('processing.parakeetMaxWordsWordStrategy', 'Words per subtitle')
                        : t('processing.parakeetMaxWords', 'Max words per subtitle')}</label>
                    <HelpIcon title={isWordStrategy
                        ? t('processing.parakeetMaxWordsHelpWordStrategy', 'Number of words in each subtitle when splitting by word count. Ignores punctuation')
                        : t('processing.parakeetMaxWordsHelp', 'Maximum number of words per subtitle when splitting sentences.')} />
                </div>
                {wordsSlider('asr-max-words', isWordStrategy
                    ? t('processing.parakeetMaxWordsWordStrategy', 'Words per subtitle')
                    : t('processing.parakeetMaxWords', 'Max words per subtitle'))}
            </div>
        );
    }

    if (strategy === 'char') {
        halves.push(
            <div className="combined-option-half" key="maxChars">
                <div className="label-with-help">
                    <label>{t('processing.parakeetMaxChars', 'Max characters per subtitle')}</label>
                    <HelpIcon title={t('processing.parakeetMaxCharsHelp', 'Only applies when splitting by approximate character count.')} />
                </div>
                <SliderWithValue
                    value={maxChars}
                    onChange={(v) => setMaxChars(parseInt(v))}
                    min={5}
                    max={100}
                    step={1}
                    orientation="Horizontal"
                    size="XSmall"
                    state={'Enabled'}
                    id="asr-max-chars"
                    ariaLabel={t('processing.parakeetMaxChars', 'Max characters per subtitle')}
                    defaultValue={60}
                    showValueBadge={true}
                    valueBadgeFormatter={(v) => Math.round(Number(v))}
                    formatValue={(v) => `${v} ${t('processing.characters', 'characters')}`}
                />
            </div>
        );
    }

    halves.push(
        <div className="combined-option-half" key="maxDuration">
            <div className="label-with-help">
                <label>{t('processing.maxDurationPerRequest', 'Max duration per request')}</label>
                <HelpIcon title={t('processing.parakeetMaxDurationHelp', 'For local ASR, long ranges are split client‑side and processed one by one (sequentially).')} />
            </div>
            <SliderWithValue
                value={maxDurationPerRequest}
                onChange={(v) => setMaxDurationPerRequest(parseInt(v))}
                min={1}
                max={10}
                step={1}
                orientation="Horizontal"
                size="XSmall"
                state={'Enabled'}
                id="asr-max-duration-slider"
                ariaLabel={t('processing.maxDurationPerRequest', 'Max duration per request')}
                defaultValue={3}
                formatValue={(v) => (
                    <>
                        {t('processing.minutesValue', '{{value}} minutes', { value: v })}
                        {selectedSegment && (() => {
                            const segmentDurationMin = (selectedSegment.end - selectedSegment.start) / 60;
                            const numRequests = Math.ceil(segmentDurationMin / Number(v || 1));
                            return numRequests > 1 ? (
                                <span className="parallel-info">{' '}({t('processing.parallelRequestsInfo', 'Will split into {{count}} parts', { count: numRequests })})</span>
                            ) : null;
                        })()}
                    </>
                )}
            />
        </div>
    );

    // Chunk the halves into `.option-group` grid cells of two — the Gemini panel's exact rhythm.
    const groups = [];
    for (let i = 0; i < halves.length; i += 2) {
        groups.push(halves.slice(i, i + 2));
    }

    return (
        <div className="asr-content-wrapper" style={{ gridColumn: '1 / -1' }}>
            <div
                className="asr-options-grid"
                style={disabled ? { opacity: 0.5, pointerEvents: 'none', userSelect: 'none' } : undefined}
            >
                {groups.map((groupHalves, idx) => (
                    <div className="option-group" key={idx}>
                        <div className="combined-options-row">
                            {groupHalves}
                        </div>
                    </div>
                ))}
            </div>
            {disabled && (
                <div className="asr-disabled-overlay">
                    <div className="asr-disabled-message">
                        {t('processing.engineServiceUnavailable', '{{engine}} service is not available', { engine: engineName || t('processing.engineGeneric', 'The ASR engine') })}
                    </div>
                </div>
            )}
        </div>
    );
};

export default AsrProcessingOptions;
