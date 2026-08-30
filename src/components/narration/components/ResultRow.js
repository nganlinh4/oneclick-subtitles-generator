import SliderWithValue from '../../common/SliderWithValue';
import StandardSlider from '../../common/StandardSlider';
import LoadingIndicator from '../../common/LoadingIndicator';
import HelpIcon from '../../common/HelpIcon';
import { formatTime } from '../../../utils/timeFormatter';

/**
 * Virtualized row renderer for F5-TTS narration results
 */
const ResultRow = ({ index, style, data }) => {
  const {
    generationResults,
    onRetry,
    retryingSubtitleId,
    currentAudio,
    isPlaying,
    playAudio,
    downloadAudio,
    t
  } = data;

  const result = generationResults[index];
  const subtitle_id = result.subtitle_id;
  const retryAvailable = data.retryAvailable === true;
  const retryTitle = retryAvailable
    ? t('narration.retry', 'Retry generation')
    : data.retryBlockedReason;
  const generateTitle = retryAvailable
    ? t('narration.generate', 'Generate this narration')
    : data.retryBlockedReason;
  const retry = () => {
    if (retryAvailable) onRetry?.(subtitle_id);
  };

  const isTransformed = result.transformations && result.transformations.transformed;

  // Generate tooltip content for transformations
  const getTransformationTooltip = () => {
    if (!isTransformed || !result.transformations) return null;

    const parts = [];
    if (result.transformations.punctuation_replaced && result.transformations.punctuation_replaced.length > 0) {
      parts.push(t('narration.transformations.punctuationReplaced', {
        punctuation: result.transformations.punctuation_replaced.join('')
      }));
    }

    const hasNumbers = result.transformations.numbers_converted && result.transformations.numbers_converted.length > 0;
    const hasDates = result.transformations.dates_converted && result.transformations.dates_converted.length > 0;

    if (hasNumbers && hasDates) {
      parts.push(t('narration.transformations.numbersAndDatesConverted'));
    } else if (hasNumbers) {
      parts.push(t('narration.transformations.numbersConverted'));
    } else if (hasDates) {
      parts.push(t('narration.transformations.datesConverted'));
    }

    return parts.join(', ');
  };

  const tooltipContent = getTransformationTooltip();

  const resultItem = (
    <div
      style={style}
      data-narration-result-state={result.success ? 'succeeded' : result.pending ? 'pending' : 'failed'}
      className={`result-item
        ${result.success ? '' : result.pending ? 'pending' : 'failed'}
        ${currentAudio && currentAudio.id === subtitle_id ? 'playing' : ''}
        ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}
        ${isTransformed ? 'transformed' : ''}`}
    >
      <div className="result-text hide-native-scrollbar">
        {/* Display 1-based row number for user-friendly sequential numbering */}
        <span className="result-id">{index + 1}.</span>
        {result.text}
        {isTransformed && tooltipContent && (
          <HelpIcon
            title={tooltipContent}
            size={12}
            className="transformation-help-icon"
            style={{ marginLeft: '8px', verticalAlign: 'middle' }}
          />
        )}
      </div>

      <div className="result-controls">
        {result.pending ? (
          <>
            {onRetry && (
              <button
                className={`pill-button secondary generate-button ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
                onClick={retry}
                title={generateTitle}
                disabled={!retryAvailable || retryingSubtitleId === subtitle_id}
              >
                {retryingSubtitleId === subtitle_id ? (
                  <LoadingIndicator
                    theme="dark"
                    showContainer={false}
                    size={14}
                    className="generate-loading-indicator"
                  />
                ) : (
                  <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>refresh</span>
                )}
              </button>
            )}
          </>
        ) : result.success ? (
          <>
            {/* Per-item trim range slider */}
            {result && (
              <div className="per-item-trim-controls" style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 8 }}>
                {(() => {
                  const getBackupName = (fn) => {
                    if (!fn) return null;
                    const lastSlash = fn.lastIndexOf('/');
                    const dir = lastSlash >= 0 ? fn.slice(0, lastSlash) : '';
                    const base = lastSlash >= 0 ? fn.slice(lastSlash + 1) : fn;
                    return `${dir ? dir + '/' : ''}backup_${base}`;
                  };
                  const backupName = getBackupName(result.filename);
                  const backupDuration = (backupName && data.itemDurations && typeof data.itemDurations[backupName] === 'number')
                    ? data.itemDurations[backupName]
                    : null;
                  const currentDuration = (typeof result.filename === 'string' && data.itemDurations && typeof data.itemDurations[result.filename] === 'number')
                    ? data.itemDurations[result.filename]
                    : null;
                  const totalDuration = (typeof backupDuration === 'number' && backupDuration > 0)
                    ? backupDuration
                    : (typeof currentDuration === 'number' && currentDuration > 0)
                      ? currentDuration
                      : (typeof result.audioDuration === 'number' && result.audioDuration > 0)
                        ? result.audioDuration
                        : (typeof result.start === 'number' && typeof result.end === 'number' && result.end > result.start)
                          ? (result.end - result.start)
                          : 0;
                  const trim = data.itemTrims[subtitle_id] ?? [0, totalDuration];
                  const [trimStart, trimEnd] = trim;
                  return (
                    <>
                      <span style={{ minWidth: 35, maxWidth: 70, display: 'inline-block', textAlign: 'center', fontSize: '1em', fontWeight: 500 }}>
                        {formatTime(trimStart, 's_ms')}
                      </span>
                      <StandardSlider
                        range
                        value={[trimStart, trimEnd]}
                        min={0}
                        max={totalDuration}
                        step={0.01}
                        minGap={0.25}
                        onChange={([start, end]) => data.setItemTrim(subtitle_id, [start, end])}
                        onDragEnd={() => data.modifySingleAudioEditCombined(result)}
                        orientation="Horizontal"
                        size="XSmall"
                        width="compact"
                        showValueIndicator={false}
                        showStops={false}
                        className="per-item-trim-slider trim-slider"
                        style={{ width: 200 }}
                      />
                      <span style={{ minWidth: 35, maxWidth: 70, display: 'inline-block', textAlign: 'center', fontSize: '1em', fontWeight: 500 }}>
                        {formatTime(trimEnd, 's_ms')}
                      </span>
                    </>
                  );
                })()}
              </div>
            )}

            {/* Per-item speed slider */}
            {result.filename && (
              <SliderWithValue
                value={data.itemSpeeds[subtitle_id] ?? 1.0}
                onChange={(v) => data.setItemSpeed(subtitle_id, parseFloat(v))}
                onDragEnd={() => data.modifySingleAudioEditCombined(result)}
                min={0.5}
                max={2.0}
                step={0.01}
                defaultValue={1.0}
                orientation="Horizontal"
                size="XSmall"
                state={data.itemProcessing[subtitle_id]?.inProgress ? 'Disabled' : 'Enabled'}
                width="compact"
                className="standard-slider-container width-compact orientation-horizontal size-XSmall state-Enabled speed-control-slider"
                style={{ width: '75px', marginRight: 0, gap: 0 }}
                id={`item-speed-${subtitle_id}`}
                ariaLabel={t('narration.speed', 'Speed')}
                formatValue={(val) => `${Number(val).toFixed(2)}x`}
              />
            )}

            <button
              className="pill-button primary"
              onClick={() => playAudio(result)}
              disabled={!!data.itemProcessing[subtitle_id]?.inProgress}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>
                {currentAudio && currentAudio.id === subtitle_id && isPlaying ? 'pause' : 'play_arrow'}
              </span>
            </button>
            <button
              className="pill-button secondary"
              onClick={() => downloadAudio(result)}
              disabled={!!data.itemProcessing[subtitle_id]?.inProgress}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>download</span>
            </button>
            {onRetry && (
              <button
                className={`pill-button secondary ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
                onClick={retry}
                title={retryTitle}
                aria-label={retryTitle}
                data-osg-action="regenerate-narration-cue"
                data-subtitle-id={String(subtitle_id)}
                disabled={!retryAvailable || retryingSubtitleId === subtitle_id || !!data.itemProcessing[subtitle_id]?.inProgress}
              >
                {retryingSubtitleId === subtitle_id ? (
                  <LoadingIndicator
                    theme="dark"
                    showContainer={false}
                    size={14}
                    className="retry-loading-indicator"
                  />
                ) : (
                  <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>refresh</span>
                )}
              </button>
            )}
          </>
        ) : (
          <>
            {onRetry && (
              <button
                className={`pill-button secondary retry-button ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
                onClick={retry}
                title={retryTitle}
                disabled={!retryAvailable || retryingSubtitleId === subtitle_id}
              >
                {retryingSubtitleId === subtitle_id ? (
                  <LoadingIndicator
                    theme="dark"
                    showContainer={false}
                    size={14}
                    className="retry-loading-indicator"
                  />
                ) : (
                  <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>refresh</span>
                )}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );

  return resultItem;
};

export default ResultRow;
