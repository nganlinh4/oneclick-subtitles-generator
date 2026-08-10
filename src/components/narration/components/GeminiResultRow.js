import SliderWithValue from '../../common/SliderWithValue';
import StandardSlider from '../../common/StandardSlider';
import LoadingIndicator from '../../common/LoadingIndicator';
import { formatTime } from '../../../utils/timeFormatter';

/**
 * Virtualized row renderer for Gemini narration results.
 * Pure component: closes over the `data` prop only.
 * @param {Object} props
 * @param {number} props.index - Row index in the virtualized list
 * @param {Object} props.style - Inline style supplied by react-window
 * @param {Object} props.data - Shared itemData from the parent List
 * @returns {JSX.Element}
 */
const GeminiResultRow = ({ index, style, data }) => {
  const {
    generationResults,
    onRetry,
    retryingSubtitleId,
    currentlyPlaying,
    isPlaying,
    playAudio,
    downloadAudio,
    t
  } = data;

  const item = generationResults[index];
  const subtitle_id = item.subtitle_id;
  const text = item.text;

  return (
    <div
      style={style}
      className={`result-item
        ${item.success ? 'success' : 'failed'}
        ${item.pending ? 'pending' : ''}
        ${currentlyPlaying === subtitle_id ? 'playing' : ''}
        ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
    >
      <div className="result-text hide-native-scrollbar">
        {/* Display 1-based row number for user-friendly sequential numbering */}
        <span className="result-id">{index + 1}.</span>
        {text}
      </div>

      <div className="result-controls">
        {item.success && (item.audioData || item.filename) ? (
          // Successful generation with audio data or filename
          <>
            {/* Per-item trim range slider */}
            {item && (
              <div className="per-item-trim-controls" style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 8 }}>
                {(() => {
                  const getBackupName = (fn) => {
                    if (!fn) return null;
                    const lastSlash = fn.lastIndexOf('/');
                    const dir = lastSlash >= 0 ? fn.slice(0, lastSlash) : '';
                    const base = lastSlash >= 0 ? fn.slice(lastSlash + 1) : fn;
                    return `${dir ? dir + '/' : ''}backup_${base}`;
                  };

                  const backupName = getBackupName(item.filename);
                  const backupDuration = (backupName && data.itemDurations && typeof data.itemDurations[backupName] === 'number')
                    ? data.itemDurations[backupName]
                    : null;
                  const currentDuration = (typeof item.filename === 'string' && data.itemDurations && typeof data.itemDurations[item.filename] === 'number')
                    ? data.itemDurations[item.filename]
                    : null;

                  const totalDuration = (typeof backupDuration === 'number' && backupDuration > 0)
                    ? backupDuration
                    : (typeof currentDuration === 'number' && currentDuration > 0)
                      ? currentDuration
                      : (typeof item.audioDuration === 'number' && item.audioDuration > 0)
                        ? item.audioDuration
                        : (typeof item.start === 'number' && typeof item.end === 'number' && item.end > item.start)
                          ? (item.end - item.start)
                          : 10;
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
                        onDragEnd={() => data.modifySingleAudioEditCombined(item)}
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

            {/* Per-item speed slider before Play/Pause */}
            {item.filename && (
              <SliderWithValue
                value={data.itemSpeeds[subtitle_id] ?? 1.0}
                onChange={(v) => data.setItemSpeed(subtitle_id, parseFloat(v))}
                onDragEnd={() => data.modifySingleAudioEditCombined(item)}
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
                id={`gemini-item-speed-${subtitle_id}`}
                ariaLabel={t('narration.speed', 'Speed')}
                formatValue={(val) => `${Number(val).toFixed(2)}x`}
              />
            )}

            <button
              className="pill-button primary"
              onClick={() => playAudio(item)}
              disabled={!!data.itemProcessing[subtitle_id]?.inProgress}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>
                {currentlyPlaying === subtitle_id && isPlaying ? 'pause' : 'play_arrow'}
              </span>
            </button>
            <button
              className="pill-button secondary"
              onClick={() => downloadAudio(item)}
              disabled={!!data.itemProcessing[subtitle_id]?.inProgress}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>download</span>
            </button>
            <button
              className={`pill-button secondary ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
              onClick={() => onRetry(subtitle_id)}
              title={!data.subtitleSource
                ? t('narration.noSourceSelectedError', 'Please select a subtitle source (Original or Translated)')
                : t('narration.retry', 'Retry generation')}
              disabled={retryingSubtitleId === subtitle_id || !data.subtitleSource || !!data.itemProcessing[subtitle_id]?.inProgress}
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
          </>
        ) : item.pending ? (
          // Pending generation - show generate button
          <>
            <button
              className={`pill-button secondary generate-button ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
              onClick={() => onRetry(subtitle_id)}
              title={!data.subtitleSource
                ? t('narration.noSourceSelectedError', 'Please select a subtitle source (Original or Translated)')
                : t('narration.generate', 'Generate this narration')}
              disabled={retryingSubtitleId === subtitle_id || !data.subtitleSource}
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
          </>
        ) : (
          // Failed generation
          <>
            <button
              className={`pill-button secondary retry-button ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
              onClick={() => onRetry(subtitle_id)}
              title={!data.subtitleSource
                ? t('narration.noSourceSelectedError', 'Please select a subtitle source (Original or Translated)')
                : t('narration.retry', 'Retry generation')}
              disabled={retryingSubtitleId === subtitle_id || !data.subtitleSource}
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
          </>
        )}
      </div>
    </div>
  );
};

export default GeminiResultRow;
