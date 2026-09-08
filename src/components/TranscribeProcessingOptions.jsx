import { useTranslation } from 'react-i18next';
import MaterialSwitch from './common/MaterialSwitch';
import SliderWithValue from './common/SliderWithValue';
import CustomDropdown from './common/CustomDropdown';

// Method-specific controls inside the existing modal, using its existing primitives.
export default function TranscribeProcessingOptions({ value, onChange }) {
    const { t } = useTranslation();
    const update = (key, next) => onChange({ ...value, [key]: next });
    return <>
        <div className="option-group">
            <p>{t('processing.transcribeMethodDescription')}</p>
        </div>
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
            <SliderWithValue id="transcribe-window" min={30} max={120} step={30}
                value={value.windowDurationSecs} defaultValue={120}
                onChange={(next) => update('windowDurationSecs', Number(next))}
                formatValue={(next) => `${next}s`} />
        </div>
        <div className="option-group">
            <div className="material-switch-container">
                <MaterialSwitch id="transcribe-speakers" checked={value.diarization}
                    onChange={(event) => update('diarization', event.target.checked)}
                    ariaLabel={t('processing.identifySpeakers', 'Identify speakers')} />
                <label htmlFor="transcribe-speakers" className="material-switch-label">{t('processing.identifySpeakers', 'Identify speakers')}</label>
            </div>
        </div>
    </>;
}
