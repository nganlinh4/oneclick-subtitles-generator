import React from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from './common/SliderWithValue';
import CustomDropdown from './common/CustomDropdown';
import HelpIcon from './common/HelpIcon';
import MaterialSwitch from './common/MaterialSwitch';

const ParakeetProcessingOptions = ({
    parakeetStrategy,
    setParakeetStrategy,
    maxDurationPerRequest,
    setMaxDurationPerRequest,
    parakeetMaxChars,
    setParakeetMaxChars,
    parakeetMaxWords,
    setParakeetMaxWords,
    parakeetPreserveSentences,
    setParakeetPreserveSentences,
    selectedSegment,
    parakeetDisabled,
    isFullVersion
}) => {
    const { t } = useTranslation();

    return (
        <div
            className={`parakeet-content-wrapper ${parakeetDisabled ? 'disabled' : ''}`}
            style={{
                opacity: parakeetDisabled ? 0.5 : 1,
                pointerEvents: parakeetDisabled ? 'none' : 'auto',
                userSelect: parakeetDisabled ? 'none' : 'auto',
                gridColumn: '1 / -1'
            }}
        >
            {/* Parakeet-only UI: dedicated layout */}
            <div className="option-group">
                {parakeetStrategy === 'sentence' ? (
                    <div className="combined-options-row">
                        <div className="combined-option-half">
                            <label>{t('processing.parakeetSplittingMethod', 'Splitting method')}</label>
                            <CustomDropdown
                                value={parakeetStrategy}
                                onChange={(value) => setParakeetStrategy(value)}
                                options={[
                                    { value: 'sentence', label: t('processing.parakeetStrategySentence', 'Split by sentence') },
                                    { value: 'word', label: t('processing.parakeetStrategyWord', 'Split by word count') },
                                    { value: 'char', label: t('processing.parakeetStrategyChar', 'Split by approximate character count') }
                                ]}
                                placeholder={t('processing.selectStrategy', 'Select strategy')}
                            />
                        </div>
                        <div className="combined-option-half">
                            <div className="label-with-help">
                                <label>{t('processing.parakeetPreserveSentences', 'Preserve full sentences')}</label>
                                <HelpIcon title={t('processing.parakeetPreserveSentencesHelp', 'When enabled, full sentences are preserved. When disabled, long sentences are split evenly by word count.')} />
                            </div>
                            <div className="material-switch-container">
                                <MaterialSwitch
                                    id="parakeet-preserve-sentences"
                                    checked={parakeetPreserveSentences}
                                    onChange={(e) => setParakeetPreserveSentences(e.target.checked)}
                                    ariaLabel={t('processing.parakeetPreserveSentences', 'Preserve full sentences')}
                                    icons={true}
                                />
                            </div>
                        </div>
                        {!parakeetPreserveSentences && (
                            <div className="combined-option-half">
                                <div className="label-with-help">
                                    <label>{t('processing.parakeetMaxWords', 'Max words per subtitle')}</label>
                                    <HelpIcon title={t('processing.parakeetMaxWordsHelp', 'Maximum number of words per subtitle when splitting sentences.')} />
                                </div>
                                <SliderWithValue
                                    value={parakeetMaxWords}
                                    onChange={(v) => setParakeetMaxWords(parseInt(v))}
                                    min={1}
                                    max={30}
                                    step={1}
                                    orientation="Horizontal"
                                    size="XSmall"
                                    state={'Enabled'}
                                    id="parakeet-max-words"
                                    ariaLabel={t('processing.parakeetMaxWords', 'Max words per subtitle')}
                                    defaultValue={7}
                                    showValueBadge={true}
                                    valueBadgeFormatter={(v) => Math.round(Number(v))}
                                    formatValue={(v) => t('processing.wordsLimit', '{{count}} {{unit}}', {
                                        count: Number(v),
                                        unit: Number(v) === 1 ? t('processing.word', 'word') : t('processing.words', 'words')
                                    })}
                                />
                            </div>
                        )}
                        <div className="combined-option-half">
                            <div className="label-with-help">
                                <label>{t('processing.maxDurationPerRequest', 'Max duration per request')}</label>
                                <HelpIcon title={t('processing.parakeetMaxDurationHelp', 'For Parakeet, long ranges are split client‑side and processed one by one (sequentially).')} />
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
                                id="parakeet-max-duration-slider"
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
                    </div>
                ) : (
                    <div className="combined-options-row">
                        <div className="combined-option-half" style={{ gap: '8px' }}>
                            <div className="label-with-help">
                                <label>{t('processing.parakeetSplittingMethod', 'Splitting method')}</label>
                            </div>
                            <CustomDropdown
                                value={parakeetStrategy}
                                onChange={(value) => setParakeetStrategy(value)}
                                options={[
                                    { value: 'sentence', label: t('processing.parakeetStrategySentence', 'Split by sentence') },
                                    { value: 'word', label: t('processing.parakeetStrategyWord', 'Split by word count') },
                                    { value: 'char', label: t('processing.parakeetStrategyChar', 'Split by approximate character count') }
                                ]}
                                placeholder={t('processing.selectStrategy', 'Select strategy')}
                            />
                        </div>
                        {(parakeetStrategy === 'char' || parakeetStrategy === 'word') && (
                            <div className="combined-option-half" style={{ gap: '8px' }}>
                                {parakeetStrategy === 'word' && (
                                    <>
                                        <div className="label-with-help">
                                            <label>{t('processing.parakeetMaxWordsWordStrategy', 'Words per subtitle')}</label>
                                            <HelpIcon title={t('processing.parakeetMaxWordsHelpWordStrategy', 'Number of words in each subtitle when splitting by word count. Ignores punctuation')} />
                                        </div>
                                        <SliderWithValue
                                            value={parakeetMaxWords}
                                            onChange={(v) => setParakeetMaxWords(parseInt(v))}
                                            min={1}
                                            max={30}
                                            step={1}
                                            orientation="Horizontal"
                                            size="XSmall"
                                            state={'Enabled'}
                                            id="parakeet-max-words"
                                            ariaLabel={t('processing.parakeetMaxWordsWordStrategy', 'Words per subtitle')}
                                            defaultValue={7}
                                            showValueBadge={true}
                                            valueBadgeFormatter={(v) => Math.round(Number(v))}
                                            formatValue={(v) => t('processing.wordsLimit', '{{count}} {{unit}}', {
                                                count: Number(v),
                                                unit: Number(v) === 1 ? t('processing.word', 'word') : t('processing.words', 'words')
                                            })}
                                        />
                                    </>
                                )}
                                {parakeetStrategy === 'char' && (
                                    <>
                                        <div className="label-with-help">
                                            <label>{t('processing.parakeetMaxChars', 'Max characters per subtitle')}</label>
                                            <HelpIcon title={t('processing.parakeetMaxCharsHelp', 'Only applies when splitting by approximate character count.')} />
                                        </div>
                                        <SliderWithValue
                                            value={parakeetMaxChars}
                                            onChange={(v) => setParakeetMaxChars(parseInt(v))}
                                            min={5}
                                            max={100}
                                            step={1}
                                            orientation="Horizontal"
                                            size="XSmall"
                                            state={'Enabled'}
                                            id="parakeet-max-chars"
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
                        {/* Parakeet: Max duration per request (sequential splitting) */}
                        <div className="combined-option-half" style={{ gap: '8px' }}>
                            <div className="label-with-help">
                                <label>{t('processing.maxDurationPerRequest', 'Max duration per request')}</label>
                                <HelpIcon title={t('processing.parakeetMaxDurationHelp', 'For Parakeet, long ranges are split client‑side and processed one by one (sequentially).')} />
                            </div>
                            <div>
                                <SliderWithValue
                                    value={maxDurationPerRequest}
                                    onChange={(v) => setMaxDurationPerRequest(parseInt(v))}
                                    min={1}
                                    max={10}
                                    step={1}
                                    orientation="Horizontal"
                                    size="XSmall"
                                    state={'Enabled'}
                                    id="parakeet-max-duration-slider"
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
                        </div>
                    </div>
                )}
            </div>
            {parakeetDisabled && (
                <div className="parakeet-disabled-overlay">
                    <div className="parakeet-disabled-message">
                        {!isFullVersion
                            ? t('processing.parakeetRequiresFullVersion', 'Parakeet requires OSG Full version')
                            : t('processing.parakeetServiceUnavailable', 'Parakeet service is not available')
                        }
                    </div>
                </div>
            )}
        </div>
    );
};

export default ParakeetProcessingOptions;