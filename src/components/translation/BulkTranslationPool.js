import React, { useState, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { parseSrtContent } from '../../utils/srtParser';

/**
 * Bulk translation file pool component
 * @param {Object} props - Component props
 * @param {Array} props.bulkFiles - Array of bulk translation files
 * @param {Function} props.onBulkFilesChange - Callback when bulk files change
 * @param {Function} props.onBulkFileRemoval - Function to remove single bulk file with translation cleanup
 * @param {Function} props.onBulkFilesRemovalAll - Function to remove all bulk files with translation cleanup
 * @param {boolean} props.disabled - Whether the pool is disabled
 * @param {number} props.splitDuration - Current split duration for segment calculation
 * @param {boolean} props.hideDropZone - Whether to hide the drop zone (for new layout)
 * @returns {JSX.Element} - Rendered component
 */
const BulkTranslationPool = ({
  bulkFiles = [],
  onBulkFilesChange,
  onBulkFileRemoval,
  onBulkFilesRemovalAll,
  disabled = false,
  splitDuration = 0,
  hideDropZone = false
}) => {
  const { t } = useTranslation();
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Calculate segment distribution for a given file's subtitles
  const calculateSegmentDistribution = useMemo(() => {
    return (subtitles) => {
      if (!subtitles || subtitles.length === 0 || splitDuration === 0) {
        return [subtitles?.length || 0]; // No split, all subtitles in one segment
      }

      // Convert splitDuration from minutes to seconds
      const splitDurationSeconds = splitDuration * 60;

      // Group subtitles into chunks based on their timestamps
      const chunks = [];
      let currentChunk = [];
      let chunkStartTime = subtitles[0]?.start || 0;

      subtitles.forEach(subtitle => {
        // If this subtitle would exceed the chunk duration, start a new chunk
        if (subtitle.start - chunkStartTime > splitDurationSeconds) {
          if (currentChunk.length > 0) {
            chunks.push(currentChunk.length);
            currentChunk = [];
            chunkStartTime = subtitle.start;
          }
        }

        currentChunk.push(subtitle);
      });

      // Add the last chunk if it's not empty
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.length);
      }

      return chunks.length > 0 ? chunks : [subtitles.length];
    };
  }, [splitDuration]);

  // Handle file parsing
  const parseFile = async (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const content = e.target.result;
          let parsedSubtitles = [];

          // Check if it's a JSON file
          if (file.name.toLowerCase().endsWith('.json')) {
            try {
              const jsonData = JSON.parse(content);
              if (Array.isArray(jsonData)) {
                parsedSubtitles = jsonData;
              } else {
                reject(new Error('JSON file must contain an array of subtitles'));
                return;
              }
            } catch (error) {
              reject(new Error('Invalid JSON format'));
              return;
            }
          } else {
            // Parse as SRT content
            parsedSubtitles = parseSrtContent(content);
          }

          if (parsedSubtitles.length === 0) {
            reject(new Error('No valid subtitles found in file'));
            return;
          }

          resolve({
            id: Date.now() + Math.random(), // Unique ID for each file
            file,
            name: file.name,
            subtitles: parsedSubtitles,
            subtitleCount: parsedSubtitles.length,
            content
          });
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  };

  // Handle file addition
  const addFiles = async (files) => {
    const newFiles = [];
    const errors = [];

    for (const file of files) {
      // Check file type
      if (!file.name.toLowerCase().endsWith('.srt') && !file.name.toLowerCase().endsWith('.json')) {
        errors.push(`${file.name}: Invalid file type. Only SRT and JSON files are supported.`);
        continue;
      }

      // Check if file already exists
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
      // You might want to show these errors to the user
    }

    if (newFiles.length > 0) {
      onBulkFilesChange([...bulkFiles, ...newFiles]);
    }
  };

  // Handle drag events
  const handleDragOver = (e) => {
    e.preventDefault();
    if (!disabled) {
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

    if (disabled) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      await addFiles(files);
    }
  };

  // Handle file input change
  const handleFileInputChange = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      await addFiles(files);
    }
    // Reset input
    e.target.value = '';
  };

  // Handle browse click
  const handleBrowseClick = () => {
    if (!disabled && fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  // Remove single file with translation cleanup
  const removeFile = (fileId) => {
    if (onBulkFileRemoval) {
      onBulkFileRemoval(fileId);
    } else {
      // Fallback to old behavior if new function not available
      onBulkFilesChange(bulkFiles.filter(bf => bf.id !== fileId));
    }
  };

  // Remove all files with translation cleanup
  const removeAllFiles = () => {
    if (onBulkFilesRemovalAll) {
      onBulkFilesRemovalAll();
    } else {
      // Fallback to old behavior if new function not available
      onBulkFilesChange([]);
    }
  };

  return (
    <div className="bulk-translation-pool">
      {/* Drag and drop area - only show if not hidden */}
      {!hideDropZone && (
        <div
          className={`bulk-drop-zone ${isDragOver ? 'drag-over' : ''} ${disabled ? 'disabled' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleBrowseClick}
        >
          <div className="drop-zone-content">
            <span className="material-symbols-rounded" style={{ fontSize: '18px' }}>description</span>
            <span className="drop-zone-text">
              {bulkFiles.length === 0
                ? t('translation.bulk.dropFiles', 'Drop SRT/JSON files for bulk translation')
                : t('translation.bulk.addMore', 'Drop more files or click to browse')
              }
            </span>
            <span className="drop-zone-optional">
              {t('translation.bulk.optional', '(optional)')}
            </span>
          </div>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".srt,.json"
            onChange={handleFileInputChange}
            style={{ display: 'none' }}
          />
        </div>
      )}

      {/* File cards */}
      {bulkFiles.length > 0 && (
        <div className="bulk-files-container">
          <div className="bulk-files-header">
            <span className="bulk-files-count">
              {t('translation.bulk.filesCount', '{{count}} files ready for bulk translation', { count: bulkFiles.length })}
            </span>
            <button
              className="remove-all-button"
              onClick={removeAllFiles}
              disabled={disabled}
              title={t('translation.bulk.removeAll', 'Remove all files')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>delete</span>
              {t('translation.bulk.removeAll', 'Remove All')}
            </button>
          </div>
          
          <div className="bulk-files-list">
            {bulkFiles.map((bulkFile) => (
              <div key={bulkFile.id} className="bulk-file-card">
                <div className="file-info">
                  <div className="file-name" title={bulkFile.name}>
                    {bulkFile.name}
                  </div>
                  <div className="file-details">
                    {splitDuration === 0 ? (
                      <span className="single-segment">
                        {t('translation.allSubtitles', 'All {{count}} subtitles', { count: bulkFile.subtitleCount })}
                      </span>
                    ) : (
                      <div className="segment-pills">
                        {calculateSegmentDistribution(bulkFile.subtitles).map((count, index) => (
                          <span key={index} className="segment-pill">
                            {count}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <button
                  className="remove-file-button"
                  onClick={() => removeFile(bulkFile.id)}
                  disabled={disabled}
                  title={t('translation.bulk.removeFile', 'Remove file')}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>close</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default BulkTranslationPool;
