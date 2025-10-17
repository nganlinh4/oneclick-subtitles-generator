import React, { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import BulkTranslationPool from './BulkTranslationPool';
import LoadingIndicator from '../common/LoadingIndicator';
import { parseSrtContent } from '../../utils/srtParser';

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
  splitDuration = 0
}) => {
  const { t } = useTranslation();
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Drop zone functionality
  const handleDragOver = (e) => {
    e.preventDefault();
    if (!isTranslating) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragOver(false);

    if (isTranslating) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      await addFiles(files);
    }
  };

  const handleBrowseClick = () => {
    if (!isTranslating && fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileInputChange = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      await addFiles(files);
    }
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

  // Add files function
  const addFiles = async (files) => {
    const newFiles = [];
    const errors = [];

    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.srt') && !file.name.toLowerCase().endsWith('.json')) {
        errors.push(`${file.name}: Invalid file type. Only SRT and JSON files are supported.`);
        continue;
      }

      if (bulkFiles.some(bf => bf.name === file.name)) {
        errors.push(`${file.name}: File already added.`);
        continue;
      }

      try {
        const parsedFile = await parseFile(file);
        newFiles.push(parsedFile);
      } catch (error) {
        errors.push(`${file.name}: ${error.message}`);
      }
    }

    if (errors.length > 0) {
      console.warn('Bulk file errors:', errors);
    }

    if (newFiles.length > 0) {
      onBulkFilesChange([...bulkFiles, ...newFiles]);
    }
  };

  // Gemini effects for translate buttons have been removed to reduce lag

  return (
    <div className="translation-row action-row">
      <div className="row-content action-content">
        {/* Controls row with drop zone and buttons */}
        <div className="bulk-controls-row">
          {/* Functional drop zone */}
          <div
            className={`bulk-drop-zone ${isDragOver ? 'drag-over' : ''} ${isTranslating ? 'disabled' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={handleBrowseClick}
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
                  onCancel();
                }}
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
                  if (!disabled) {
                    onTranslate();
                  }
                }}
                disabled={disabled}
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
                    onClick={onDownloadAll}
                    title={t('translation.bulk.downloadAll', 'Download all translated files')}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>download</span>
                    {t('translation.bulk.downloadAll', 'Download All')}
                  </button>
                  <button
                    className="download-zip-button"
                    onClick={onDownloadZip}
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
          onBulkFilesChange={onBulkFilesChange}
          onBulkFileRemoval={onBulkFileRemoval}
          onBulkFilesRemovalAll={onBulkFilesRemovalAll}
          disabled={isTranslating}
          splitDuration={splitDuration}
          hideDropZone={true}
        />
      </div>
    </div>
  );
};

export default TranslationActions;
