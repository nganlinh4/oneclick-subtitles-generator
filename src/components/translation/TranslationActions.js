import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import BulkTranslationPool from './BulkTranslationPool';
import LoadingIndicator from '../common/LoadingIndicator';
import { parseSrtContent } from '../../utils/srtParser';
import { showWarningToast } from '../../utils/toastUtils';

// A drop can reject many files at once (wrong extension, duplicate name, malformed JSON). Report
// them as one bounded, actionable toast instead of a toast-storm or (the previous behavior) total
// silence -- see the drop-rejection tests colocated with this file.
const MAX_REPORTED_REJECTIONS = 3;

/**
 * Translation action buttons component
 * @param {Object} props - Component props
 * @param {boolean} props.isTranslating - Whether translation is in progress
 * @param {Function} props.onTranslate - Function to handle translation
 * @param {Function} props.onCancel - Function to handle cancellation
 * @param {boolean} props.disabled - Whether the buttons are disabled
 * @param {boolean} props.isFormatMode - Whether we're in format mode (only original language)
 * @param {Array} props.bulkFiles - Array of bulk translation files
 * @param {Function} props.onBulkFilesChange - Callback when bulk files change
 * @param {Function} props.onBulkFileRemoval - Function to remove single bulk file with translation cleanup
 * @param {Function} props.onBulkFilesRemovalAll - Function to remove all bulk files with translation cleanup
 * @param {boolean} props.hasBulkTranslations - Whether there are bulk translation results
 * @param {Function} props.onDownloadAll - Function to download all bulk translations
 * @param {Function} props.onDownloadZip - Function to download bulk translations as ZIP
 * @param {boolean} props.isExporting - Whether a bulk export owns the save dialog
 * @param {{current: boolean}} props.exportPendingRef - Synchronous bulk export owner gate
 * @param {number} props.splitDuration - Current split duration for segment calculation
 * @returns {JSX.Element} - Rendered component
 */
const TranslationActions = ({
  isTranslating,
  onTranslate,
  onCancel,
  disabled = false,
  isFormatMode = false,
  bulkFiles = [],
  onBulkFilesChange,
  onBulkFileRemoval,
  onBulkFilesRemovalAll,
  hasBulkTranslations = false,
  onDownloadAll,
  onDownloadZip,
  isExporting = false,
  exportPendingRef,
  splitDuration = 0
}) => {
  const { t } = useTranslation();
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const exportOwnsControls = () => isExporting || exportPendingRef?.current === true;
  const exportControlsDisabled = exportOwnsControls();
  const controlsAreDisabled = isTranslating || exportControlsDisabled;

  // Drop zone functionality
  const handleDragOver = (e) => {
    e.preventDefault();
    if (!isTranslating && !exportOwnsControls()) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    if (exportOwnsControls()) return;
    setIsDragOver(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    if (exportOwnsControls()) return;
    setIsDragOver(false);

    if (isTranslating) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      await addFiles(files);
    }
  };

  const handleBrowseClick = () => {
    if (!isTranslating && !exportOwnsControls() && fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleBrowseKeyDown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handleBrowseClick();
  };

  const handleFileInputChange = async (e) => {
    if (exportOwnsControls()) return;
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      await addFiles(files);
    }
    if (exportOwnsControls()) return;
    e.target.value = '';
  };

  // Parse file function (copied from BulkTranslationPool)
  const parseFile = async (file) => {
    const text = await file.text();

    if (file.name.toLowerCase().endsWith('.srt')) {
      const subtitles = parseSrtContent(text);
      return {
        id: Date.now() + Math.random(),
        name: file.name,
        subtitles: subtitles,
        subtitleCount: subtitles.length,
        type: 'srt'
      };
    } else if (file.name.toLowerCase().endsWith('.json')) {
      try {
        const jsonData = JSON.parse(text);
        let subtitles = [];

        if (Array.isArray(jsonData)) {
          subtitles = jsonData;
        } else if (jsonData.subtitles && Array.isArray(jsonData.subtitles)) {
          subtitles = jsonData.subtitles;
        } else {
          throw new Error('Invalid JSON format. Expected array of subtitles or object with subtitles property.');
        }

        return {
          id: Date.now() + Math.random(),
          name: file.name,
          subtitles: subtitles,
          subtitleCount: subtitles.length,
          type: 'json'
        };
      } catch (error) {
        throw new Error(`Failed to parse JSON: ${error.message}`);
      }
    } else {
      throw new Error('Unsupported file type');
    }
  };

  // Translate a single rejection's reason. Only the customer's own filename (never a path) and a
  // parser's own error text (position/token info, not file content) ever reach this string.
  const rejectionReason = ({ code, detail }) => {
    if (code === 'duplicate') {
      return t('translation.bulk.rejectedDuplicate', 'a file with this name was already added');
    }
    if (code === 'invalidType') {
      return t('translation.bulk.rejectedInvalidType', 'unsupported file type (only .srt and .json are supported)');
    }
    return t('translation.bulk.rejectedParseError', 'could not be read ({{message}})', { message: detail });
  };

  // One bounded toast per drop, not one per rejected file -- see MAX_REPORTED_REJECTIONS above.
  const reportRejectedFiles = (rejections) => {
    if (rejections.length === 0) return;
    const lines = rejections.map((rejection) => `${rejection.name}: ${rejectionReason(rejection)}`);
    const shown = lines.slice(0, MAX_REPORTED_REJECTIONS);
    const hiddenCount = lines.length - shown.length;
    const details = hiddenCount > 0
      ? `${shown.join('; ')}; ${t('translation.bulk.rejectedMore', '+{{count}} more', { count: hiddenCount })}`
      : shown.join('; ');
    showWarningToast(t(
      'translation.bulk.rejectedSummary',
      '{{count}} file(s) skipped: {{details}}',
      { count: rejections.length, details }
    ));
  };

  // Add files function
  const addFiles = async (files) => {
    if (exportOwnsControls()) return;
    const newFiles = [];
    const rejections = [];

    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.srt') && !file.name.toLowerCase().endsWith('.json')) {
        rejections.push({ name: file.name, code: 'invalidType' });
        continue;
      }

      if (bulkFiles.some(bf => bf.name === file.name)) {
        rejections.push({ name: file.name, code: 'duplicate' });
        continue;
      }

      try {
        const parsedFile = await parseFile(file);
        if (exportOwnsControls()) return;
        newFiles.push(parsedFile);
      } catch (error) {
        rejections.push({ name: file.name, code: 'parseError', detail: error.message });
      }
    }

    reportRejectedFiles(rejections);

    if (newFiles.length > 0 && !exportOwnsControls()) {
      onBulkFilesChange([...bulkFiles, ...newFiles]);
    }
  };

  const changeBulkFilesUnlessExporting = (nextFiles) => {
    if (!exportOwnsControls()) onBulkFilesChange?.(nextFiles);
  };

  const removeBulkFileUnlessExporting = (fileId) => {
    if (exportOwnsControls()) return;
    if (onBulkFileRemoval) {
      onBulkFileRemoval(fileId);
    } else {
      onBulkFilesChange?.(bulkFiles.filter((bulkFile) => bulkFile.id !== fileId));
    }
  };

  const removeAllBulkFilesUnlessExporting = () => {
    if (exportOwnsControls()) return;
    if (onBulkFilesRemovalAll) {
      onBulkFilesRemovalAll();
    } else {
      onBulkFilesChange?.([]);
    }
  };

  const runUnlessExporting = (operation) => {
    if (exportOwnsControls()) return { status: 'busy' };
    return operation?.();
  };

  // Gemini effects for translate buttons have been removed to reduce lag

  return (
    <div className="translation-row action-row">
      <div className="row-content action-content">
        {/* Controls row with drop zone and buttons */}
        <div className="bulk-controls-row">
          {/* Functional drop zone */}
          <div
            className={`bulk-drop-zone ${isDragOver && !controlsAreDisabled ? 'drag-over' : ''} ${controlsAreDisabled ? 'disabled' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={handleBrowseClick}
            onKeyDown={handleBrowseKeyDown}
            role="button"
            tabIndex={controlsAreDisabled ? -1 : 0}
            aria-disabled={controlsAreDisabled}
          >
            <div className="drop-zone-content">
              <span className="material-symbols-rounded" style={{ fontSize: '18px' }}>docs_add_on</span>
              <span className="drop-zone-text">
                {bulkFiles.length === 0
                  ? t('translation.bulk.dropFilesWithSettings', 'Drop SRT/JSON files for bulk translation with above settings')
                  : t('translation.bulk.addMoreWithSettings', 'Drop more files or click to browse (will use above settings)')
                }
              </span>
              <span className="drop-zone-optional">
                {t('translation.bulk.optional', '(optional)')}
              </span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".srt,.json"
              onChange={handleFileInputChange}
              disabled={controlsAreDisabled}
              style={{ display: 'none' }}
            />
          </div>

          {/* Translation buttons */}
          <div className="translation-buttons-section">
          {isTranslating ? (
            <>
              <button
                className="translate-button processing"
                disabled={true}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
                    <LoadingIndicator
                      theme="light"
                      showContainer={false}
                      size={20}
                      className="translation-loading-indicator"
                    />
                  </div>
                  <span>{t('translation.translating', 'Translating...')}</span>
                </div>
              </button>
              <button
                className="cancel-translation-button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  runUnlessExporting(onCancel);
                }}
                disabled={exportControlsDisabled}
                title={t('translation.cancelTooltip', 'Cancel translation process')}
              >
                <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>close</span>
                {t('translation.cancel', 'Cancel')}
              </button>
            </>
          ) : (
            <>
              <button
                className={`translate-button ${isFormatMode ? 'format-button' : ''}`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!disabled && !exportOwnsControls()) {
                    onTranslate();
                  }
                }}
                disabled={disabled || exportControlsDisabled}
              >
                {isFormatMode ? (
                  <>
                    <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>format_align_left</span>
                    {t('translation.format', 'Format')}
                  </>
                ) : (
                  <>
                    <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>translate</span>
                    {t('translation.translate', 'Translate')}
                  </>
                )}
              </button>

              {/* Bulk download buttons */}
              {hasBulkTranslations && (
                <div className="bulk-download-buttons">
                  <button
                    className="download-all-button"
                    onClick={() => runUnlessExporting(onDownloadAll)}
                    disabled={exportControlsDisabled}
                    title={t('translation.bulk.downloadAll', 'Download all translated files')}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>download</span>
                    {t('translation.bulk.downloadAll', 'Download All')}
                  </button>
                  <button
                    className="download-zip-button"
                    onClick={() => runUnlessExporting(onDownloadZip)}
                    disabled={exportControlsDisabled}
                    title={t('translation.bulk.downloadZip', 'Download all as ZIP')}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>archive</span>
                    {t('translation.bulk.downloadZip', 'Download ZIP')}
                  </button>
                </div>
              )}
            </>
          )}
          </div>
        </div>

        {/* Files container spans full width */}
        <BulkTranslationPool
          bulkFiles={bulkFiles}
          onBulkFilesChange={changeBulkFilesUnlessExporting}
          onBulkFileRemoval={removeBulkFileUnlessExporting}
          onBulkFilesRemovalAll={removeAllBulkFilesUnlessExporting}
          disabled={controlsAreDisabled}
          splitDuration={splitDuration}
          hideDropZone={true}
        />
      </div>
    </div>
  );
};

export default TranslationActions;
