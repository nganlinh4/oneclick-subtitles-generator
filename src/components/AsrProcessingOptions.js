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
 * chars / max duration) for every engine, plus a capability-gated forced-language picker. Reuses the
 * existing `processing.parakeet*` i18n keys and CSS classes so vi/ko stay translated and styling holds.
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

    const strategyDropdown = (
        <CustomDropdown
            value={strategy}
            onChange={(value) => setStrategy(value)}
            options={[
                { value: 'sentence', label: t('processing.parakeetStrategySentence', 'Split by sentence') },
                { value: 'word', label: t('processing.parakeetStrategyWord', 'Split by word count') },
                { value: 'char', label: t('processing.parakeetStrategyChar', 'Split by approximate character count') },
            ]}
            placeholder={t('processing.selectStrategy', 'Select strategy')}
        />
    );

    const maxDurationSlider = (
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
    );

    return (
        <div
            className={`parakeet-content-wrapper ${disabled ? 'disabled' : ''}`}
            style={{
                opacity: disabled ? 0.5 : 1,
                pointerEvents: disabled ? 'none' : 'auto',
                userSelect: disabled ? 'none' : 'auto',
                gridColumn: '1 / -1',
            }}
        >
            <div className="option-group">
                {supportsLanguage && (
                    <div className="combined-options-row">
                        <div className="combined-option-half">
                            <div className="label-with-help">
                                <label>{t('processing.asrLanguage', 'Language')}</label>
                                <HelpIcon title={t('processing.asrLanguageHelp', 'Force a transcription language, or leave on Auto-detect.')} />
                            </div>
                            <CustomDropdown
                                value={language || 'auto'}
                                onChange={(value) => setLanguage(value)}
                                options={languageOptions}
                                placeholder={t('processing.asrLanguage', 'Language')}
                            />
                        </div>
                    </div>
                )}

                {strategy === 'sentence' ? (
                    <div className="combined-options-row">
                        <div className="combined-option-half">
                            <label>{t('processing.parakeetSplittingMethod', 'Splitting method')}</label>
                            {strategyDropdown}
                        </div>
                        <div className="combined-option-half">
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
                        {!preserveSentences && (
                            <div className="combined-option-half">
                                <div className="label-with-help">
                                    <label>{t('processing.parakeetMaxWords', 'Max words per subtitle')}</label>
                                    <HelpIcon title={t('processing.parakeetMaxWordsHelp', 'Maximum number of words per subtitle when splitting sentences.')} />
                                </div>
                                <SliderWithValue
                                    value={maxWords}
                                    onChange={(v) => setMaxWords(parseInt(v))}
                                    min={1}
                                    max={30}
                                    step={1}
                                    orientation="Horizontal"
                                    size="XSmall"
                                    state={'Enabled'}
                                    id="asr-max-words"
                                    ariaLabel={t('processing.parakeetMaxWords', 'Max words per subtitle')}
                                    defaultValue={7}
                                    showValueBadge={true}
                                    valueBadgeFormatter={(v) => Math.round(Number(v))}
                                    formatValue={(v) => t('processing.wordsLimit', '{{count}} {{unit}}', {
                                        count: Number(v),
                                        unit: Number(v) === 1 ? t('processing.word', 'word') : t('processing.words', 'words'),
                                    })}
                                />
                            </div>
                        )}
                        <div className="combined-option-half">
                            <div className="label-with-help">
                                <label>{t('processing.maxDurationPerRequest', 'Max duration per request')}</label>
                                <HelpIcon title={t('processing.parakeetMaxDurationHelp', 'For local ASR, long ranges are split client‑side and processed one by one (sequentially).')} />
                            </div>
                            {maxDurationSlider}
                        </div>
                    </div>
                ) : (
                    <div className="combined-options-row">
                        <div className="combined-option-half" style={{ gap: '8px' }}>
                            <div className="label-with-help">
                                <label>{t('processing.parakeetSplittingMethod', 'Splitting method')}</label>
                            </div>
                            {strategyDropdown}
                        </div>
                        {(strategy === 'char' || strategy === 'word') && (
                            <div className="combined-option-half" style={{ gap: '8px' }}>
                                {strategy === 'word' && (
                                    <>
                                        <div className="label-with-help">
                                            <label>{t('processing.parakeetMaxWordsWordStrategy', 'Words per subtitle')}</label>
                                            <HelpIcon title={t('processing.parakeetMaxWordsHelpWordStrategy', 'Number of words in each subtitle when splitting by word count. Ignores punctuation')} />
                                        </div>
                                        <SliderWithValue
                                            value={maxWords}
                                            onChange={(v) => setMaxWords(parseInt(v))}
                                            min={1}
                                            max={30}
                                            step={1}
                                            orientation="Horizontal"
                                            size="XSmall"
                                            state={'Enabled'}
                                            id="asr-max-words"
                                            ariaLabel={t('processing.parakeetMaxWordsWordStrategy', 'Words per subtitle')}
                                            defaultValue={7}
                                            showValueBadge={true}
                                            valueBadgeFormatter={(v) => Math.round(Number(v))}
                                            formatValue={(v) => t('processing.wordsLimit', '{{count}} {{unit}}', {
                                                count: Number(v),
                                                unit: Number(v) === 1 ? t('processing.word', 'word') : t('processing.words', 'words'),
                                            })}
                                        />
                                    </>
                                )}
                                {strategy === 'char' && (
                                    <>
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
                                    </>
                                )}
                            </div>
                        )}
                        <div className="combined-option-half" style={{ gap: '8px' }}>
                            <div className="label-with-help">
                                <label>{t('processing.maxDurationPerRequest', 'Max duration per request')}</label>
                                <HelpIcon title={t('processing.parakeetMaxDurationHelp', 'For local ASR, long ranges are split client‑side and processed one by one (sequentially).')} />
                            </div>
                            <div>{maxDurationSlider}</div>
                        </div>
                    </div>
                )}
            </div>
            {disabled && (
                <div className="parakeet-disabled-overlay">
                    <div className="parakeet-disabled-message">
                        {t('processing.engineServiceUnavailable', '{{engine}} service is not available', { engine: engineName || t('processing.engineGeneric', 'The ASR engine') })}
                    </div>
                </div>
            )}
        </div>
    );
};

export default AsrProcessingOptions;
