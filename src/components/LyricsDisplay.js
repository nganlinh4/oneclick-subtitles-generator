import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { EVENTS, subscribe } from '../events/bus';
import '../styles/LyricsDisplay.css';
import TimelineVisualization from './lyrics/TimelineVisualization';
import LyricsHeader from './lyrics/LyricsHeader';
import { useLyricsEditor } from '../hooks/useLyricsEditor';
import { useLyricsSave } from '../hooks/useLyricsSave';
import { useLyricsDrag } from '../hooks/useLyricsDrag';
import { downloadTXT, downloadSRT, downloadJSON } from '../utils/fileUtils';
import { completeDocument, summarizeDocument } from '../services/geminiService';
import LyricsVirtualizedList from './LyricsVirtualizedList';
import LyricsDownloadAndOutput from './LyricsDownloadAndOutput';

// Helper function to download files
const downloadFile = (content, filename, type = 'text/plain') => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const LyricsDisplay = ({
  matchedLyrics,
  currentTime,
  onLyricClick,
  duration,
  onUpdateLyrics,
  allowEditing = false,
  seekTime = null,
  timeFormat = 'seconds',
  onSaveSubtitles = null, // New callback for when subtitles are saved
  videoSource = null, // Video source URL for audio analysis
  translatedSubtitles = null, // Translated subtitles
  videoTitle = 'subtitles', // Video title for download filenames
  onSegmentSelect = null, // Callback for segment selection
  selectedSegment = null, // Currently selected segment
  isProcessingSegment = false // Whether a segment is being processed
}) => {
  const { t } = useTranslation();
  // Initialize zoom to 1 (100% - show entire timeline)
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState(0);
  const [centerTimelineAt, setCenterTimelineAt] = useState(null);
  const rowHeights = useRef({});
  const listRef = useRef(null);

  const [txtContent, setTxtContent] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [splitDuration, setSplitDuration] = useState(() => {
    // Get the split duration from localStorage or use default (0 = no split)
    return parseInt(localStorage.getItem('consolidation_split_duration') || '0');
  });
  const [selectedRange, setSelectedRange] = useState(null); // Track selected range for subtitle split

  // Get naming information for downloads
  const getNamingInfo = () => {
    // Get uploaded SRT info
    let sourceSubtitleName = '';
    try {
      const uploadedSrtInfo = localStorage.getItem('uploaded_srt_info');
      if (uploadedSrtInfo) {
        const srtInfo = JSON.parse(uploadedSrtInfo);
        if (srtInfo.hasUploaded && srtInfo.fileName) {
          sourceSubtitleName = srtInfo.fileName;
        }
      }
    } catch (error) {
      console.error('Error parsing uploaded SRT info:', error);
    }

    // Get video name (from uploaded file or video title)
    let videoName = '';
    const uploadedFileUrl = localStorage.getItem('current_file_url');
    if (uploadedFileUrl) {
      // For uploaded files, try to get the original file name
      // This might be stored in the uploadedFile object or we can use videoTitle
      videoName = videoTitle;
    } else {
      // For YouTube videos, use the video title
      videoName = videoTitle;
    }

    // Get target languages
    let targetLanguages = [];
    try {
      const translationTargetLanguage = localStorage.getItem('translation_target_language');
      if (translationTargetLanguage) {
        // Try to parse as JSON first (for multi-language)
        try {
          const parsed = JSON.parse(translationTargetLanguage);
          if (Array.isArray(parsed)) {
            targetLanguages = parsed;
          } else {
            targetLanguages = [{ value: parsed }];
          }
        } catch {
          // If not JSON, treat as single language string
          targetLanguages = [{ value: translationTargetLanguage }];
        }
      }
    } catch (error) {
      console.error('Error parsing target languages:', error);
    }

    return {
      sourceSubtitleName,
      videoName,
      targetLanguages
    };
  };
  const [consolidationStatus, setConsolidationStatus] = useState('');

  const [showWaveformLongVideos, setShowWaveformLongVideos] = useState(() => {
    // Load from localStorage, default to false if not set
    return localStorage.getItem('show_waveform_long_videos') === 'true';
  });
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(() => {
    // Load from localStorage, default to true (auto-scroll enabled) if not set
    return localStorage.getItem('lyrics_auto_scroll') !== 'false';
  });

  // NEW: Simplified and deterministic row height calculation.
  // We calculate height based on the number of newline characters (\n),
  // but we cap it at a maximum of 2 lines. CSS will handle the rest.
  const getRowHeight = index => {
    if (rowHeights.current[index] !== undefined) {
      return rowHeights.current[index];
    }
    const lyric = matchedLyrics[index];
    if (!lyric) return 50; // Default height

    // Count explicit lines from '\n'
    const lineCount = (lyric.text || '').split('\n').length;
    // Cap the line count at 2 for height calculation purposes
    const cappedLineCount = Math.min(lineCount, 2);

    const baseHeight = 50; // Base height for a single-line item
    const extraLineHeight = 20; // Additional height for the second line
    const height = baseHeight + (cappedLineCount - 1) * extraLineHeight;

    rowHeights.current[index] = height;
    return height;
  };


  // Reset row heights when lyrics change
  useEffect(() => {
    rowHeights.current = {};
    if (listRef.current) {
      listRef.current.resetAfterIndex(0);
    }
  }, [matchedLyrics]);

  // Listen for changes to the waveform settings in localStorage
  useEffect(() => {
    const handleStorageChange = (event) => {
      if (event.key === 'show_waveform_long_videos') {
        setShowWaveformLongVideos(event.newValue === 'true');
      }
    };

    // Also listen for custom events for immediate updates
    const handleWaveformLongVideosChange = (event) => {
      setShowWaveformLongVideos(event.detail.value);
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('waveformLongVideosChanged', handleWaveformLongVideosChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('waveformLongVideosChanged', handleWaveformLongVideosChange);
    };
  }, []);

  // Save auto-scroll setting to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('lyrics_auto_scroll', autoScrollEnabled.toString());
  }, [autoScrollEnabled]);

  // Listen for consolidation status updates
  useEffect(() => {
    const handleConsolidationStatus = (event) => {
      if (event.detail && event.detail.message) {
        setConsolidationStatus(event.detail.message);

        // Check if this is a completion message
        if (event.detail.message.includes('Processing completed for all')) {
          // Clear the status after a delay
          setTimeout(() => {
            setConsolidationStatus('');
          }, 3000);
        }
      }
    };

    window.addEventListener('consolidation-status', handleConsolidationStatus);

    return () => {
      window.removeEventListener('consolidation-status', handleConsolidationStatus);
    };
  }, []);

  const {
    lyrics,
    isSticky,
    setIsSticky,
    isAtOriginalState,
    isAtSavedState,
    canUndo,
    canRedo,
    canJumpToCheckpoint,
    handleUndo,
    handleRedo,
    handleReset,
    handleJumpToCheckpoint,
    startDrag,
    handleDrag,
    endDrag,
    isDragging,
    getLastDragEnd,
    handleDeleteLyric,
    handleTextEdit,
    handleInsertLyric,
    handleMergeLyrics,
    updateSavedLyrics,
    handleSplitSubtitles,
    captureStateBeforeMerge,
    clearSubtitlesInRange,
    moveSubtitlesInRange,
    beginRangeMove,
    previewRangeMove,
    commitRangeMove,
    cancelRangeMove,
    applyTimings
  } = useLyricsEditor(matchedLyrics, onUpdateLyrics);

  // Find current lyric index based on time
  const currentIndex = lyrics.findIndex((lyric, index) => {
    const nextLyric = lyrics[index + 1];
    return currentTime >= lyric.start &&
      (nextLyric ? currentTime < (lyric.end + (nextLyric.start - lyric.end) / 2) - 0.001 : currentTime <= lyric.end);
  });

  // Auto-scroll to the current lyric using react-window's scrollToItem (stable)
  useEffect(() => {
    if (autoScrollEnabled && currentIndex >= 0 && listRef.current) {
      listRef.current.scrollToItem(currentIndex, 'center');
    }
  }, [currentIndex, autoScrollEnabled]);

  // Watch for seekTime changes to center the timeline
  useEffect(() => {
    if (seekTime !== null) {
      // Center the timeline on the seek time (one-shot)
      setCenterTimelineAt(seekTime);
      // Reset in next frame so it doesn't keep re-centering on every render
      requestAnimationFrame(() => setCenterTimelineAt(null));
    }
  }, [seekTime]);

  // Generate comprehensive filename based on priority system
  const generateFilename = (source, namingInfo = {}) => {
    const { sourceSubtitleName = '', videoName = '', targetLanguages = [] } = namingInfo;

    // Priority 1: Source subtitle name (remove extension)
    let baseName = '';
    if (sourceSubtitleName) {
      baseName = sourceSubtitleName.replace(/\.(srt|json)$/i, '');
    }
    // Priority 2: Video name (remove extension)
    else if (videoName) {
      baseName = videoName.replace(/\.[^/.]+$/, '');
    }
    // Fallback: Use video title or default
    else {
      baseName = videoTitle || 'subtitles';
    }

    // Add language suffix for translations
    let langSuffix = '';
    if (source === 'translated' && targetLanguages.length > 0) {
      if (targetLanguages.length === 1) {
        // Single language: use the language name
        const langName = targetLanguages[0].value || targetLanguages[0];
        langSuffix = `_${langName.toLowerCase().replace(/\s+/g, '_')}`;
      } else {
        // Multiple languages: use multi_lang
        langSuffix = '_multi_lang';
      }
    }

    return `${baseName}${langSuffix}`;
  };

  // Handle download request from modal
  const handleDownload = (source, format, namingInfo = {}) => {
    const subtitlesToUse = source === 'translated' ? translatedSubtitles : lyrics;

    if (subtitlesToUse && subtitlesToUse.length > 0) {
      const baseFilename = generateFilename(source, namingInfo);

      switch (format) {
        case 'srt':
          downloadSRT(subtitlesToUse, `${baseFilename}.srt`);
          break;
        case 'json':
          downloadJSON(subtitlesToUse, `${baseFilename}.json`);
          break;
        case 'txt': {
          const content = downloadTXT(subtitlesToUse, `${baseFilename}.txt`);
          setTxtContent(content);
          break;
        }
        default:
          break;
      }
    }
  };

  // Handle process request from modal
  const handleProcess = async (source, processType, model, splitDurationParam, customPrompt, namingInfo = {}) => {
    const subtitlesToUse = source === 'translated' ? translatedSubtitles : lyrics;

    // Store the current source in localStorage for language detection
    localStorage.setItem('current_processing_source', source);

    if (!subtitlesToUse || subtitlesToUse.length === 0) return;

    // First, get the text content if we don't have it yet
    let textContent = txtContent;
    if (!textContent) {
      textContent = subtitlesToUse.map(subtitle => subtitle.text).join('\n\n');
      setTxtContent(textContent);
    }

    // Use the provided split duration or the state value
    const splitDurationToUse = splitDurationParam !== undefined ? splitDurationParam : splitDuration;

    // Save the split duration setting to localStorage
    localStorage.setItem('consolidation_split_duration', splitDurationToUse.toString());

    // Update the state
    setSplitDuration(splitDurationToUse);

    // Clear any previous status
    setConsolidationStatus('');

    try {
      let result;
      if (processType === 'consolidate') {
        result = await completeDocument(textContent, model, customPrompt, splitDurationToUse);
      } else if (processType === 'summarize') {
        result = await summarizeDocument(textContent, model, customPrompt);
      }

      // Check if the result is JSON and extract plain text
      if (result && typeof result === 'string' && (result.trim().startsWith('{') || result.trim().startsWith('['))) {
        try {
          const jsonResult = JSON.parse(result);


          // For summarize feature
          if (jsonResult.summary) {
            let plainText = jsonResult.summary;

            // Add key points if available
            if (jsonResult.keyPoints && Array.isArray(jsonResult.keyPoints) && jsonResult.keyPoints.length > 0) {
              plainText += '\n\nKey Points:\n';
              jsonResult.keyPoints.forEach((point, index) => {
                plainText += `\n${index + 1}. ${point}`;
              });
            }

            result = plainText;

          }
          // For consolidate feature
          else if (jsonResult.content) {
            result = jsonResult.content;

          }
          // For any other JSON structure
          else if (jsonResult.text) {
            result = jsonResult.text;

          }
        } catch (e) {

          // Keep the original result if parsing fails
        }
      }

      // Result is ready for download

      // Show success toast using centralized system
      window.addToast(
        processType === 'consolidate'
          ? t('output.documentCompleted', 'Document completed successfully')
          : t('output.summaryCompleted', 'Summary completed successfully'),
        'success',
        3000
      );

      // Download the processed document
      const baseFilename = generateFilename(source, namingInfo);
      const processTypeSuffix = processType === 'consolidate' ? 'completed' : 'summary';
      const filename = `${baseFilename}_${processTypeSuffix}.txt`;
      downloadFile(result, filename);
    } catch (error) {
      console.error(`Error ${processType === 'consolidate' ? 'completing' : 'summarizing'} document:`, error);

      // Show error status
      setConsolidationStatus(t('consolidation.error', 'Error processing document: {{message}}', { message: error.message }));
    } finally {
      // Processing is complete
    }
  };

  // Save current subtitles to cache + handle save-before-update / save-after-streaming events
  const { handleSave } = useLyricsSave({ lyrics, updateSavedLyrics, onSaveSubtitles });

  // Listen for capture-before-merge events to support undo/redo for merging operations
  useEffect(() => {
    const handleCaptureBeforeMerge = () => {


      // Capture the current state before merging happens
      if (lyrics && lyrics.length > 0) {

        captureStateBeforeMerge();
      }
    };

    const unsubscribe3 = subscribe(EVENTS.CAPTURE_BEFORE_MERGE, handleCaptureBeforeMerge);

    return () => {
      unsubscribe3();
    };
  }, [lyrics, captureStateBeforeMerge]); // Include captureStateBeforeMerge in dependencies

  // Mouse + touch drag handlers for adjusting lyric timings
  const { handleMouseDown, handleTouchStart } = useLyricsDrag({
    lyrics,
    duration,
    startDrag,
    handleDrag,
    endDrag
  });

  return (
    <div className={`lyrics-display ${Object.keys(isDragging()).length > 0 ? 'dragging-active' : ''}`}>
      <div className="controls-timeline-container">
        <LyricsHeader
          allowEditing={allowEditing}
          isSticky={isSticky}
          setIsSticky={setIsSticky}
          canUndo={canUndo}
          canRedo={canRedo}
          canJumpToCheckpoint={canJumpToCheckpoint}
          isAtOriginalState={isAtOriginalState}
          isAtSavedState={isAtSavedState}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onReset={handleReset}
          onJumpToCheckpoint={handleJumpToCheckpoint}
          onSave={handleSave}
          autoScrollEnabled={autoScrollEnabled}
          setAutoScrollEnabled={setAutoScrollEnabled}
          lyrics={lyrics}
          onSplitSubtitles={handleSplitSubtitles}
          selectedRange={selectedRange}
        />

        <TimelineVisualization
          lyrics={lyrics}
          currentTime={currentTime}
          duration={duration}
          onTimelineClick={onLyricClick}
          zoom={zoom}
          setZoom={setZoom}
          panOffset={panOffset}
          setPanOffset={setPanOffset}
          centerOnTime={centerTimelineAt}
          timeFormat={timeFormat}
          videoSource={videoSource}
          showWaveformLongVideos={showWaveformLongVideos}
          onSegmentSelect={onSegmentSelect}
          selectedSegment={selectedSegment}
          isProcessingSegment={isProcessingSegment}
          onClearRange={clearSubtitlesInRange}
          onMoveRange={moveSubtitlesInRange}
          onBeginMoveRange={beginRangeMove}
          onPreviewMoveRange={previewRangeMove}
          onCommitMoveRange={commitRangeMove}
          onCancelMoveRange={cancelRangeMove}
          onSelectedRangeChange={setSelectedRange}
          onApplyTimings={applyTimings}
        />
      </div>

      <div className="lyrics-container-wrapper">
        {lyrics.length > 0 ? (
          <LyricsVirtualizedList
            listRef={listRef}
            lyrics={lyrics}
            currentIndex={currentIndex}
            currentTime={currentTime}
            allowEditing={allowEditing}
            isDragging={isDragging}
            getRowHeight={getRowHeight}
            onLyricClick={(time) => {
              // Center the timeline on the clicked lyric
              setCenterTimelineAt(time);
              // Reset the center time in the next frame to allow future clicks to work
              requestAnimationFrame(() => {
                setCenterTimelineAt(null);
              });
              // Call the original onLyricClick function
              onLyricClick(time);
            }}
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
            getLastDragEnd={getLastDragEnd}
            onDelete={handleDeleteLyric}
            onTextEdit={handleTextEdit}
            onInsert={handleInsertLyric}
            onMerge={handleMergeLyrics}
            timeFormat={timeFormat}
          />
        ) : (
          <div className="lyrics-empty-state" style={{ height: 300 }}>
            <div className="empty-add-hotspot" title={t('lyrics.addFirst', 'Add first subtitle')}>
              <button
                className="empty-insert-lyric-btn"
                onClick={() => handleInsertLyric(0)}
                aria-label={t('lyrics.addFirst', 'Add first subtitle')}
              >
                <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>add</span>
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="help-text-container">
        {allowEditing && (
          <div className="help-text">
            <p dangerouslySetInnerHTML={{
              __html: (lyrics.length === 0
                ? t(
                    'lyrics.emptyTimingInstructions',
                    'Hiện có {{count}} dòng phụ đề. Hãy kéo thả trên vùng chỉnh sửa phụ đề (nơi có hoạt ảnh bàn tay lướt phải) để tạo phụ đề tự động bằng AI. Có thể kéo từ đầu đến cuối để tạo sub toàn video hoặc chỉ 1 đoạn nếu muốn',
                    { count: lyrics.length }
                  )
                : t(
                    'lyrics.timingInstructions',
                    'Hiện có ??? dòng phụ đề. Kéo dấu thời gian để điều chỉnh thời gian cho mỗi phụ đề. Chế độ "Dính" sẽ điều chỉnh tất cả phụ đề theo sau. Chế độ "Cuộn" sẽ giúp tự dời tầm nhìn lên dòng sub đang chạy. 5 nút còn lại: Chia nhỏ sub, Lưu, Đặt lại, Hoàn tác, Làm lại'
                  )
                    .replace('??? dòng', `<strong>${lyrics.length} dòng</strong>`)
                    .replace('??? subtitle lines', `<strong>${lyrics.length} subtitle lines</strong>`)
                    .replace('???개의 자막 라인', `<strong>${lyrics.length}개의 자막 라인</strong>`))
            }} />
          </div>
        )}

        <LyricsDownloadAndOutput
          lyrics={lyrics}
          translatedSubtitles={translatedSubtitles}
          consolidationStatus={consolidationStatus}
          isModalOpen={isModalOpen}
          onOpenModal={() => setIsModalOpen(true)}
          onCloseModal={() => setIsModalOpen(false)}
          onDownload={handleDownload}
          onProcess={handleProcess}
          namingInfo={getNamingInfo()}
        />
      </div>
    </div>
  );
};

export default LyricsDisplay;
