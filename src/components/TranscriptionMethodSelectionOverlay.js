import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import newDarkImg from '../assets/transcription-methods/new_dark.png';
import newLightImg from '../assets/transcription-methods/new_light.png';
import oldDarkImg from '../assets/transcription-methods/old_dark.png';
import oldLightImg from '../assets/transcription-methods/old_light.png';
import parakeetDarkImg from '../assets/transcription-methods/parakeet_dark.png';
import parakeetLightImg from '../assets/transcription-methods/parakeet_light.png';

/**
 * Overlay for first-time transcription method selection
 */
const TranscriptionMethodSelectionOverlay = ({ isOpen, onMethodSelect, onClose }) => {
    const { t } = useTranslation();
    const [isDarkTheme, setIsDarkTheme] = useState(() => {
        return document.documentElement.getAttribute('data-theme') === 'dark';
    });

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

    const methods = React.useMemo(() => [
        {
            id: 'new',
            name: t('processing.transcriptionMethodNewName'),
            desc: t('processing.transcriptionMethodNewDescription'),
            img: isDarkTheme ? newDarkImg : newLightImg
        },
        {
            id: 'old',
            name: t('processing.transcriptionMethodOldName'),
            desc: t('processing.transcriptionMethodOldDescription'),
            img: isDarkTheme ? oldDarkImg : oldLightImg
        },
        {
            id: 'nvidia-parakeet',
            name: t('processing.transcriptionMethodParakeetName'),
            desc: t('processing.transcriptionMethodParakeetDescription'),
            img: isDarkTheme ? parakeetDarkImg : parakeetLightImg
        }
    ], [isDarkTheme, t]);

    const handleMethodClick = (methodId) => {
        onMethodSelect(methodId);
        onClose();
    };

    if (!isOpen) return null;

    return ReactDOM.createPortal(
        <div className="transcription-method-overlay">
            <div className="method-selection-overlay">
                <h2>{t('processing.transcriptionMethodOverlayTitle')}</h2>
                <div className="methods-grid">
                    {methods.map(method => (
                        <div
                            key={method.id}
                            className="method-column"
                            onClick={() => handleMethodClick(method.id)}
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