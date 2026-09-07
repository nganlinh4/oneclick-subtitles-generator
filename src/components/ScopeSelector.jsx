import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Format seconds into HH:MM:SS or MM:SS with bounded 2-digit padding.
 * Handles > 10 hours cleanly (e.g. 10:00:00).
 *
 * @param {number} timeInSeconds
 * @returns {string}
 */
export const formatTimeHms = (timeInSeconds) => {
  if (!Number.isFinite(timeInSeconds) || timeInSeconds <= 0) {
    return '00:00';
  }
  const s = Math.floor(timeInSeconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

/**
 * Validates selected range duration.
 * Must be at least 500ms (0.5s) per Spec R3 / T2.3.1.
 *
 * @param {number} startSec
 * @param {number} endSec
 * @returns {{ valid: boolean, error?: string }}
 */
export const validateRangeDuration = (startSec, endSec) => {
  if (
    typeof startSec !== 'number' ||
    typeof endSec !== 'number' ||
    !Number.isFinite(startSec) ||
    !Number.isFinite(endSec) ||
    startSec < 0 ||
    endSec < 0 ||
    startSec > endSec
  ) {
    return {
      valid: false,
      error: 'Selection range too short (minimum 500ms)',
    };
  }
  const durationMs = Math.round((endSec - startSec) * 1000);
  if (durationMs < 500 || (endSec - startSec) < 0.4995) {
    return {
      valid: false,
      error: 'Selection range too short (minimum 500ms)',
    };
  }
  return { valid: true };
};

/**
 * Scope selector component: Whole video vs Selected range with duration badges.
 */
export const ScopeSelector = ({
  scope = 'Whole video',
  onScopeChange,
  videoDuration = 0,
  selectedSegment = null,
}) => {
  const { t } = useTranslation();

  const isWhole = scope === 'Whole video' || scope === 'whole';

  const rangeInfo = useMemo(() => {
    if (isWhole) {
      const dur = Math.max(0, videoDuration || 0);
      return {
        formatted: `00:00 – ${formatTimeHms(dur)} (${Math.round(dur)}s)`,
        isValid: true,
        error: null,
      };
    }

    if (!selectedSegment) {
      const dur = Math.max(0, videoDuration || 0);
      return {
        formatted: `00:00 – ${formatTimeHms(dur)} (${Math.round(dur)}s)`,
        isValid: true,
        error: null,
      };
    }

    const rawStart = selectedSegment.start ?? 0;
    const rawEnd = selectedSegment.end ?? 0;
    const validation = validateRangeDuration(rawStart, rawEnd);
    const start = Math.max(0, rawStart);
    const end = Math.max(start, rawEnd);
    const duration = Math.max(0, end - start);

    return {
      formatted: `${formatTimeHms(start)} – ${formatTimeHms(end)} (${duration.toFixed(1)}s)`,
      isValid: validation.valid,
      error: validation.valid ? null : t('processing.rangeTooShortError', validation.error),
    };
  }, [isWhole, videoDuration, selectedSegment, t]);

  return (
    <div className="scope-selector-row">
      <div className="scope-selector-group">
        <span className="scope-label">{t('processing.scopeLabel', 'Scope')}:</span>
        <div className="scope-segmented-control" role="group" aria-label="Media Scope">
          <button
            type="button"
            className={`scope-button ${isWhole ? 'active' : ''}`}
            data-testid="scope-whole-video"
            data-osg-action="scope-whole-video"
            onClick={() => onScopeChange?.('Whole video')}
          >
            {t('processing.scopeWholeVideo', 'Whole video')}
          </button>
          <button
            type="button"
            className={`scope-button ${!isWhole ? 'active' : ''}`}
            data-testid="scope-selected-range"
            data-osg-action="scope-selected-range"
            onClick={() => onScopeChange?.('Selected range')}
          >
            {t('processing.scopeSelectedRange', 'Selected range')}
          </button>
        </div>
      </div>

      <div className="scope-duration-badge" data-testid="scope-duration-badge">
        <span className="material-symbols-rounded" style={{ fontSize: '16px', display: 'inline-block', verticalAlign: 'middle' }}>schedule</span>
        <span>{rangeInfo.formatted}</span>
      </div>

      {!rangeInfo.isValid && rangeInfo.error && (
        <div className="scope-error-text" role="alert">
          {rangeInfo.error}
        </div>
      )}
    </div>
  );
};

export default ScopeSelector;
