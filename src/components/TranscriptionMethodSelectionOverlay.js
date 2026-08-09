import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useEngineStatus } from '../hooks/useEngineStatus';
import CloseButton from './common/CloseButton';
import newDarkImg from '../assets/transcription-methods/new_dark.png';
import newLightImg from '../assets/transcription-methods/new_light.png';
import oldDarkImg from '../assets/transcription-methods/old_dark.png';
import oldLightImg from '../assets/transcription-methods/old_light.png';
import parakeetDarkImg from '../assets/transcription-methods/parakeet_dark.png';
import parakeetLightImg from '../assets/transcription-methods/parakeet_light.png';
import whisperDarkImg from '../assets/transcription-methods/whisper_dark.png';
import whisperLightImg from '../assets/transcription-methods/whisper_light.png';
import { ASR_ENGINES } from '../services/engines/asrEngines';

/**
 * Overlay for first-time transcription method selection
 */
const TranscriptionMethodSelectionOverlay = ({ isOpen, onMethodSelect, onClose, onCloseAndHideModal }) => {
    const { t } = useTranslation();
    const [isDarkTheme, setIsDarkTheme] = useState(() => {
        return document.documentElement.getAttribute('data-theme') === 'dark';
    });

    // Version detection state
    const [isVercelMode] = useState(() => {
        return typeof window !== 'undefined' && window.location.hostname.includes('vercel.app');
    });
    // Per-engine Parakeet availability (replaces the old is_full_version gate).
    const { isReady } = useEngineStatus();

    // Update theme detection
    useEffect(() => {
        const updateTheme = () => {
            setIsDarkTheme(document.documentElement.getAttribute('data-theme') === 'dark');
        };

        // Initial check
        updateTheme();

        // Listen for theme changes
        const observer = new MutationObserver(updateTheme);
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });

        return () => observer.disconnect();
    }, []);

    const methods = React.useMemo(() => {
        // Determine which methods are disabled based on per-engine availability
        const isParakeetDisabled = !isReady('parakeet'); // Disabled when the Parakeet engine isn't running
        const isOldMethodDisabled = isVercelMode; // Disabled only in Vercel mode

        return [
            {
                id: 'new',
                name: t('processing.transcriptionMethodNewName'),
                desc: t('processing.transcriptionMethodNewDescription'),
                img: isDarkTheme ? newDarkImg : newLightImg,
                disabled: false
            },
            {
                id: 'old',
                name: t('processing.transcriptionMethodOldName'),
                desc: t('processing.transcriptionMethodOldDescription'),
                img: isDarkTheme ? oldDarkImg : oldLightImg,
                disabled: isOldMethodDisabled
            },
            {
                id: 'nvidia-parakeet',
                name: t('processing.transcriptionMethodParakeetName'),
                desc: t('processing.transcriptionMethodParakeetDescription'),
                img: isDarkTheme ? parakeetDarkImg : parakeetLightImg,
                disabled: isParakeetDisabled
            },
            // On-demand local GPU ASR engines (faster-whisper, …) — install from the Tools panel; each
            // card is grayed out until its engine is installed and the service reports ready.
            ...ASR_ENGINES.map((e) => ({
                id: e.id,
                name: e.name,
                desc: t('processing.transcriptionMethodLocalAsrDescription', 'Local GPU transcription — install from the Tools panel, then it runs offline.'),
                img: isDarkTheme ? whisperDarkImg : whisperLightImg,
                disabled: !isReady(e.id)
            })),
            {
                id: 'groq-whisper',
                name: t('processing.transcriptionMethodWhisperName'),
                desc: t('processing.transcriptionMethodWhisperDescription'),
                img: isDarkTheme ? whisperDarkImg : whisperLightImg,
                disabled: true
            }
        ];
    }, [isDarkTheme, t, isReady, isVercelMode]);

    const handleMethodClick = (method) => {
        if (method.disabled) return; // Prevent clicks on disabled methods
        onMethodSelect(method.id);
        onClose();
    };

    if (!isOpen) return null;

    const handleBackdropClick = (e) => {
        if (e.target === e.currentTarget) {
            onCloseAndHideModal();
        }
    };

    const handleContentClick = (e) => {
        e.stopPropagation();
    };

    const handleCloseClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent?.stopImmediatePropagation?.();
        // Call onClose immediately without setTimeout to ensure proper event handling
        // This matches the ESC key behavior where the event is handled synchronously
        onCloseAndHideModal();
    };

    return ReactDOM.createPortal(
         <div className="transcription-method-overlay" onClick={handleBackdropClick}>
             <div className="method-selection-overlay" onClick={handleContentClick}>
                 <div className="method-selection-overlay-header">
                     <h2>{t('processing.transcriptionMethodOverlayTitle')}</h2>
                     <CloseButton onClick={handleCloseClick} variant="modal" />
                 </div>
                 <div className="methods-grid">
                     {methods.map(method => (
                         <div
                             key={method.id}
                             className={`method-column ${method.disabled ? 'disabled' : ''}`}
                             onClick={() => handleMethodClick(method)}
                             style={method.disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                         >
                             <div className="method-name">{method.name}</div>
                             <img src={method.img} alt={method.name} />
                             <div className="method-desc">{method.desc}</div>
                         </div>
                     ))}
                 </div>
             </div>
         </div>,
         document.body
     );
};

export default TranscriptionMethodSelectionOverlay;