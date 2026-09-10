import { useTranslation } from 'react-i18next';
import MaterialSwitch from './common/MaterialSwitch';
import SliderWithValue from './common/SliderWithValue';
import CustomDropdown from './common/CustomDropdown';

// Method-specific controls inside the existing modal, using its existing primitives.
export default function TranscribeProcessingOptions({ value, onChange, selectedSegment, method }) {
    const { t } = useTranslation();
    const update = (key, next) => onChange({ ...value, [key]: next });
    const windowMinutes = Math.max(1, Math.round(value.windowDurationSecs / 60));
    const physicalWindowSeconds = windowMinutes * 60;
    const ownedWindowSeconds = method === 'gemini-transcribe-live'
        ? Math.max(1, physicalWindowSeconds - 3)
        : physicalWindowSeconds;
    const segmentSeconds = Math.max(0, (selectedSegment?.end || 0) - (selectedSegment?.start || 0));
    const requestCount = Math.max(1, Math.ceil(segmentSeconds / ownedWindowSeconds));
    return <>
        <div className="option-group">
            <label htmlFor="transcribe-language">{t('processing.languageLabel', 'Language')}</label>
            <CustomDropdown
                id="transcribe-language"
                value={value.languageHints[0] || 'auto'}
                onChange={(next) => update('languageHints', next === 'auto' ? [] : [next])}
                options={[
                    { value: 'auto', label: t('processing.detectAutomatically', 'Detect automatically') },
                    ...[['en', 'English'], ['vi', 'Tiếng Việt'], ['ko', '한국어'], ['ja', '日本語'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['zh', '中文']].map(([code, label]) => ({ value: code, label })),
                ]}
            />
        </div>
        <div className="option-group">
            <label htmlFor="transcribe-window">{t('processing.maxDurationPerRequest', 'Maximum duration per request')}</label>
            <SliderWithValue id="transcribe-window" min={1} max={10} step={1}
                value={windowMinutes} defaultValue={10}
                onChange={(next) => update('windowDurationSecs', Number(next) * 60)}
                formatValue={(next) => <>
                    {t('processing.minutesValue', '{{value}} minutes', { value: next })}
                    {requestCount > 1 ? <span className="parallel-info">{' '}({t('processing.parallelRequestsInfo', 'Will split into {{count}} parallel requests', { count: requestCount })})</span> : null}
                </>} />
        </div>
        {method === 'gemini-transcribe' ? <div className="option-group">
            <div className="material-switch-container">
                <MaterialSwitch id="transcribe-speakers" checked={value.diarization}
                    onChange={(event) => update('diarization', event.target.checked)}
                    ariaLabel={t('processing.identifySpeakers', 'Identify speakers')} />
                <label htmlFor="transcribe-speakers" className="material-switch-label">{t('processing.identifySpeakers', 'Identify speakers')}</label>
            </div>
        </div> : null}
    </>;
}
