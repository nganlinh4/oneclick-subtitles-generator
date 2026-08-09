import React from 'react';
import { useTranslation } from 'react-i18next';
import CustomDropdown from './common/CustomDropdown';
import HelpIcon from './common/HelpIcon';
import specialStarIcon from '../assets/specialStar.svg';
import { useEngineStatus } from '../hooks/useEngineStatus';
import { buildMethodDescriptors } from '../services/engines/transcriptionEngineRegistry';

/**
 * Method selector for the video processing modal header.
 *
 * Renders the labelled method dropdown, contextual help, and the button that re-opens the first-time
 * method selection overlay. Options are built from the transcription-engine registry (single source of
 * truth) — Gemini, Parakeet, and every catalog ASR engine — each disabled per its computed availability.
 * Pure: all option state lives in the parent.
 */

const ICON_STYLE = { width: '16px', height: '16px', marginRight: '6px', verticalAlign: 'middle' };
const GEMINI_OLD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" style="width: 16px; height: 16px; margin-right: 6px; vertical-align: middle;"><path d="M16 8.016A8.522 8.522 0 008.016 16h-.032A8.521 8.521 0 000 8.016v-.032A8.521 8.521 0 007.984 0h.032A8.522 8.522 0 0016 7.984v.032z" fill="url(#prefix__paint0_radial_980_20147)"/><defs><radialGradient id="prefix__paint0_radial_980_20147" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(16.1326 5.4553 -43.70045 129.2322 1.588 6.503)"><stop offset=".067" stop-color="#9168C0"/><stop offset=".343" stop-color="#5684D1"/><stop offset=".672" stop-color="#1BA1E3"/></radialGradient></defs></svg>`;
const NVIDIA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" class="bi bi-nvidia" viewBox="0 0 16 16" height="16" width="16" style="width: 16px; height: 16px; margin-right: 6px; vertical-align: middle;"><path d="M1.635 7.146S3.08 5.012 5.97 4.791v-0.774C2.77 4.273 0 6.983 0 6.983s1.57 4.536 5.97 4.952v-0.824c-3.23 -0.406 -4.335 -3.965 -4.335 -3.965M5.97 9.475v0.753c-2.44 -0.435 -3.118 -2.972 -3.118 -2.972S4.023 5.958 5.97 5.747v0.828h-0.004c-1.021 -0.123 -1.82 0.83 -1.82 0.83s0.448 1.607 1.824 2.07M6 2l-0.03 2.017A7 7 0 0 1 6.252 4c3.637 -0.123 6.007 2.983 6.007 2.983s-2.722 3.31 -5.557 3.31q-0.39 -0.002 -0.732 -0.065v0.883q0.292 0.039 0.61 0.04c2.638 0 4.546 -1.348 6.394 -2.943 0.307 0.246 1.561 0.842 1.819 1.104 -1.757 1.47 -5.852 2.657 -8.173 2.657a7 7 0 0 1 -0.65 -0.034V14H16l0.03 -12zm-0.03 3.747v-0.956a6 6 0 0 1 0.282 -0.015c2.616 -0.082 4.332 2.248 4.332 2.248S8.73 9.598 6.743 9.598c-0.286 0 -0.542 -0.046 -0.773 -0.123v-2.9c1.018 0.123 1.223 0.572 1.835 1.593L9.167 7.02s-0.994 -1.304 -2.67 -1.304a5 5 0 0 0 -0.527 0.031" stroke-width="1"></path></svg>`;

const methodIcon = (id) => {
    if (id === 'new') return <img src={specialStarIcon} alt="" style={ICON_STYLE} />;
    if (id === 'old') return <span style={{ display: 'inline-flex' }} dangerouslySetInnerHTML={{ __html: GEMINI_OLD_SVG }} />;
    if (id === 'nvidia-parakeet') return <span style={{ display: 'inline-flex' }} dangerouslySetInnerHTML={{ __html: NVIDIA_SVG }} />;
    return null; // catalog ASR engines: name only
};

const VideoProcessingModalMethodSelector = ({
    isVercelMode,
    method,
    setMethod,
    retryLock,
    onReopenSelection,
}) => {
    const { t } = useTranslation();
    const engineStatus = useEngineStatus();

    const descriptors = buildMethodDescriptors(engineStatus, { isVercelMode });
    const methodOptions = descriptors.map((d) => {
        const text = d.labelKey ? t(d.labelKey, d.labelDefault) : d.labelDefault;
        let suffix = '';
        if (!d.available) {
            suffix = d.id === 'old'
                ? ` (${t('processing.notAvailableVercelVersion', 'not available in Vercel version')})`
                : ` (${t('processing.engineStartingUp', 'starting up…')})`;
        }
        return {
            value: d.id,
            disabled: !d.available,
            label: (
                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                    {methodIcon(d.id)}{text}{suffix}
                </span>
            ),
        };
    });

    return (
        <div className={`header-switch-group ${retryLock ? 'disabled' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <label style={{ minWidth: 64 }}>{t('processing.methodLabel', 'Method')}</label>
            <CustomDropdown
                value={method}
                onChange={(value) => setMethod(value)}
                options={methodOptions}
                placeholder={t('processing.methodLabel', 'Method')}
                disabled={retryLock}
                style={{ maxWidth: '200px' }}
            />
            <HelpIcon title={retryLock
                ? t('processing.changeTranscriptionMethodRetryLocked', 'Cannot change method while in retry mode with old Gemini method')
                : isVercelMode
                    ? t('processing.methodHelpVercel', 'Only the new method is available in Vercel version. The old method requires server-side video processing capabilities.')
                    : t('processing.inlineExtractionHelp', 'Use the old method when the new method fails; may be slower depending on the situation')
            } />
            <button
                onClick={onReopenSelection}
                className="method-selection-reopen-btn"
                title={retryLock
                    ? t('processing.changeTranscriptionMethodRetryLocked', 'Cannot change method while in retry mode with old Gemini method')
                    : t('processing.changeTranscriptionMethod', 'Change transcription method')
                }
                disabled={retryLock}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '40px',
                    height: '40px',
                    border: 'none',
                    borderRadius: '20px',
                    background: 'var(--md-surface-container)',
                    color: 'var(--md-on-surface)',
                    cursor: retryLock ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s var(--md-easing-standard)',
                    boxShadow: 'var(--md-elevation-level1)',
                    fontSize: '20px',
                    lineHeight: '1',
                    fontFamily: 'var(--ms-font-family)',
                    fontVarianceSettings: '"wght" var(--ms-wght), "GRAD" var(--ms-grad), "opsz" var(--ms-opsz)'
                }}
                onMouseEnter={(e) => {
                    e.target.style.backgroundColor = 'var(--md-surface-container-high)';
                    e.target.style.boxShadow = 'var(--md-elevation-level2)';
                }}
                onMouseLeave={(e) => {
                    e.target.style.backgroundColor = 'var(--md-surface-container)';
                    e.target.style.boxShadow = 'var(--md-elevation-level1)';
                }}
            >
                <span className="material-symbols-rounded" style={{ fontSize: '20px', display: 'inline-block', verticalAlign: 'middle' }}>view_apps</span>
            </button>
        </div>
    );
};

export default VideoProcessingModalMethodSelector;
