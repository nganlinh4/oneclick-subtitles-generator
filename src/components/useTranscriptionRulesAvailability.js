import { useState, useEffect } from 'react';
import {
    getCurrentCacheId,
    getTranscriptionRulesSync,
} from '../utils/transcriptionRulesStore';

export const hasMeaningfulTranscriptionRules = (rules) => (
    rules !== null
    && typeof rules === 'object'
    && !Array.isArray(rules)
    && Object.keys(rules).length > 0
    && Object.values(rules).some((value) => {
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'string') return value.trim() !== '';
        if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
        return value !== null && value !== undefined;
    })
);

/**
 * Tracks whether saved transcription/analysis rules exist and are non-empty.
 *
 * The project-backed transcription-rules store is the sole authority. Its event carries
 * the cache/project scope that produced the snapshot, so a late event from another media
 * cannot enable rules for the active project.
 *
 * @param {boolean} useTranscriptionRules current toggle value
 * @param {Function} setUseTranscriptionRules toggle setter (disabled when no rules)
 * @returns {boolean} whether usable rules are available
 */
const useTranscriptionRulesAvailability = (useTranscriptionRules, setUseTranscriptionRules) => {
    const [transcriptionRulesAvailable, setTranscriptionRulesAvailable] = useState(false);

    useEffect(() => {
        const applyAvailability = (rules) => {
            const hasRules = hasMeaningfulTranscriptionRules(rules);
            setTranscriptionRulesAvailable(hasRules);
            if (!hasRules && useTranscriptionRules) {
                setUseTranscriptionRules(false);
            }
        };

        applyAvailability(getTranscriptionRulesSync());

        const handleRulesUpdate = (event) => {
            if (event.detail?.cacheId !== getCurrentCacheId()) return;
            applyAvailability(event.detail?.rules ?? null);
        };
        window.addEventListener('transcriptionRulesUpdated', handleRulesUpdate);

        return () => {
            window.removeEventListener('transcriptionRulesUpdated', handleRulesUpdate);
        };
    }, [setUseTranscriptionRules, useTranscriptionRules]);

    return transcriptionRulesAvailable;
};

export default useTranscriptionRulesAvailability;
