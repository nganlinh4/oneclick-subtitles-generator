import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { convertAudioToVideo } from '../../utils/audioToVideoConverter';
import { SERVER_URL } from '../../config';
import LoadingIndicator from '../common/LoadingIndicator';
import '../../styles/FileUploadInput.css';

const FileUploadInput = ({ uploadedFile, setUploadedFile, onVideoSelect, className, isSrtOnlyMode, setIsSrtOnlyMode, setStatus, subtitlesData, setVideoSegments, setSegmentsStatus }) => {
  const { t } = useTranslation();
  const [fileInfo, setFileInfo] = useState(null);
  const [error, setError] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const fileInputRef = useRef(null);

  const lastSelectedFileRef = useRef(null);
  const skipLargeFileCopyRef = useRef(false);


  // Maximum file size in MB (5GB = 5120MB)
  const MAX_FILE_SIZE_MB = 5120;

  // Supported file formats - wrapped in useMemo to avoid dependency issues
  const SUPPORTED_VIDEO_FORMATS = useMemo(() => [
    "video/mp4",
    "video/mpeg",
    "video/mov",           // This might be incorrect
    "video/avi",
    "video/x-flv",
    "video/mpg",
    "video/webm",
    "video/wmv",
    "video/3gpp",
    "video/quicktime"      // Add this - correct MIME type for .mov files
  ], []);

  const SUPPORTED_AUDIO_FORMATS = useMemo(() => [
    "audio/wav", "audio/mp3", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac", "audio/mpeg"
  ], []);

  // Check if file is a video - wrapped in useCallback to avoid dependency issues
  const isVideoFile = useCallback((mimeType) => {
    return SUPPORTED_VIDEO_FORMATS.includes(mimeType);
  }, [SUPPORTED_VIDEO_FORMATS]);

  // Check if file is an audio - wrapped in useCallback to avoid dependency issues
  const isAudioFile = useCallback((mimeType) => {
    return SUPPORTED_AUDIO_FORMATS.includes(mimeType);
  }, [SUPPORTED_AUDIO_FORMATS]);

  // Display file information - wrapped in useCallback to avoid dependency issues
  const displayFileInfo = useCallback((file, originalFile = null) => {
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);

    // If we have an original audio file, use its information for display
    // This maintains the illusion that we're still working with an audio file
    if (originalFile && originalFile.type.startsWith('audio/')) {
      setFileInfo({
        // Keep the original audio filename
        name: originalFile.name,
        // Keep the original audio type
        type: originalFile.type,
        size: `${fileSizeMB} MB`,
        mediaType: 'Audio'
      });
    } else {
      const mediaType = isVideoFile(file.type) ? 'Video' : 'Audio';
      setFileInfo({
        name: file.name,
        type: file.type,
        size: `${fileSizeMB} MB`,
        mediaType
      });
    }
  }, [isVideoFile]);

  // Update fileInfo when uploadedFile changes (for auto-downloaded files)
  useEffect(() => {
    if (uploadedFile && !fileInfo) {
      displayFileInfo(uploadedFile);
    }
  }, [uploadedFile, fileInfo, displayFileInfo]);

  // Validate file type and size
  const validateFile = (file) => {
    // Check file size
    const fileSizeMB = file.size / (1024 * 1024);
    if (fileSizeMB > MAX_FILE_SIZE_MB) {
      setError(t('fileUpload.sizeError', 'File size exceeds the maximum limit of {{size}} MB.', { size: MAX_FILE_SIZE_MB }));
      return false;
    }

    // Check file type
    if (!isVideoFile(file.type) && !isAudioFile(file.type)) {
      setError(t('fileUpload.formatError', 'Unsupported file format. Please upload a supported video or audio file.'));
      return false;
    }

    setError('');
    return true;
  };

  // Handle file selection
  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    await processFile(file);
  };

  // Process the file with improved handling for large files
  const processFile = async (file) => {
    if (file) {
        // Remember the last selected file so we can retry without Multer if needed
        lastSelectedFileRef.current = file;

      if (validateFile(file)) {
        // Set loading state immediately
        setIsLoading(true);

        // Clear ALL video-related storage first
        localStorage.removeItem('current_video_url');
        localStorage.removeItem('current_file_cache_id');
        localStorage.removeItem('split_result'); // Clear any cached split result
        // Preserve gemini_file_* cache entries so identical files can reuse Files API URIs

        // Revoke any existing object URLs to prevent memory leaks
        if (localStorage.getItem('current_file_url')) {
          URL.revokeObjectURL(localStorage.getItem('current_file_url'));
          localStorage.removeItem('current_file_url');
        }

        // Check if this is an audio file
        const isAudio = file.type.startsWith('audio/');
        let processedFile = file;

        // If it's an audio file, immediately convert it to video
        if (isAudio) {
          try {
            // Show loading state
            setFileInfo({
              name: file.name,
              type: file.type,
              size: `${(file.size / (1024 * 1024)).toFixed(2)} MB`,
              mediaType: 'Audio',
              converting: true
            });

            // Convert audio to video
            processedFile = await convertAudioToVideo(file);

            // Update file info but keep the original audio file information for display
            // This maintains the illusion that we're still working with an audio file
            displayFileInfo(processedFile, file);
          } catch (error) {
            console.error('Error converting audio to video:', error);
            setError(t('fileUpload.conversionError', 'Failed to convert audio to video. Please try again.'));
            setUploadedFile(null);
            setFileInfo(null);
            setIsLoading(false);
            return;
          }
        }

        // For large files (>500MB), copy to videos directory for better handling
        const fileSizeMB = processedFile.size / (1024 * 1024);
        console.log(`File size: ${fileSizeMB.toFixed(2)} MB`);
        if (fileSizeMB > 500 && !skipLargeFileCopyRef.current) {
          try {
            // Show copying progress for large files
            setFileInfo(prev => ({
              ...prev,
              copying: true,
              copyProgress: 0
            }));

            // Copy file to videos directory with progress tracking
            const copiedFile = await copyFileToVideosDirectory(processedFile, (progress) => {
              setFileInfo(prev => ({
                ...prev,
                copyProgress: progress
              }));
            });

            // Use the copied file reference
            processedFile = copiedFile;

            // Update file info to remove copying state
            setFileInfo(prev => ({
              ...prev,
              copying: false,
              copyProgress: undefined
            }));
          } catch (error) {
            console.error('Error copying large file:', error);
            setError(
              (
                <>
                  {t('fileUpload.copyErrorShort', 'Failed to copy large file.')} {' '}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setError('');
                      skipLargeFileCopyRef.current = true;
                      const f = lastSelectedFileRef.current;
                      if (f) {
                        // Retry processing but skip Multer-based copy this time
                        setTimeout(() => processFile(f), 0);
                      }
                    }}
                  >
                    {t('fileUpload.retrySkipMulter', 'Retry by skipping Multer?')}
                  </a>
                </>
              )
            );
            setUploadedFile(null);
            setFileInfo(null);
            setIsLoading(false);
            return;
          }
        }

        // Create a new object URL for the processed file
        const objectUrl = URL.createObjectURL(processedFile);
        localStorage.setItem('current_file_url', objectUrl);
        try {
          if (!window.__videoBlobMap) window.__videoBlobMap = {};
          window.__videoBlobMap[objectUrl] = processedFile;
        } catch {}

        // Clear any selected YouTube video state via parent callback
        if (onVideoSelect) {
          onVideoSelect(null);
        }

        // If we're in SRT-only mode, switch to normal mode since we now have a video
        if (isSrtOnlyMode && setIsSrtOnlyMode) {
          setIsSrtOnlyMode(false);
        }

        // Store the processed file for actual processing
        setUploadedFile(processedFile);

        // If we have subtitles data already (from uploaded SRT), no need to prepare segments
        if (subtitlesData && subtitlesData.length > 0) {
          // With simplified processing, we don't need to prepare video segments
          // The subtitles are already available and ready to use
          console.log('Subtitles already available from uploaded SRT file');
          if (setStatus) {
            setStatus({
              message: t('output.subtitlesReady', 'Subtitles are ready!'),
              type: 'success'
            });
          }
        }

        // For non-audio files, display the file info normally
        // For audio files, we've already set the file info with the original audio details
        if (!isAudio) {
          displayFileInfo(processedFile);
        }

        // Clear loading state after processing is complete
        setIsLoading(false);
        // Reset skip flag after successful processing
        skipLargeFileCopyRef.current = false;
      } else {
        setUploadedFile(null);
        setFileInfo(null);
        if (localStorage.getItem('current_file_url')) {
          URL.revokeObjectURL(localStorage.getItem('current_file_url'));
          localStorage.removeItem('current_file_url');
        }
        // Clear loading state if validation fails
        setIsLoading(false);
      }
    }
  };

  // Copy large files to videos directory for better handling
  const copyFileToVideosDirectory = async (file, onProgress) => {
    console.log(`Starting copy operation for file: ${file.name}, size: ${(file.size / (1024 * 1024)).toFixed(2)} MB`);
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('filename', file.name);

      const xhr = new XMLHttpRequest();

      // Track upload progress
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const progress = Math.round((e.loaded / e.total) * 100);
          onProgress(progress);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          try {
            const response = JSON.parse(xhr.responseText);
            // Create a new File object with the server path reference
            const copiedFile = new File([file], file.name, {
              type: file.type,
              lastModified: file.lastModified
            });
            // Add server path reference for later use
            copiedFile.serverPath = response.filePath;
            copiedFile.isCopiedToServer = true;
            resolve(copiedFile);
          } catch (error) {
            reject(new Error('Invalid server response'));
          }
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      });

      xhr.addEventListener('error', () => {
        reject(new Error('Upload failed'));
      });

      xhr.open('POST', `${SERVER_URL}/api/copy-large-file`);
      xhr.send(formData);
    });
  };

  // Trigger file input click
  const handleBrowseClick = () => {
    // Don't allow clicking when loading
    if (isLoading) return;

    fileInputRef.current.click();
  };

  // Handle drag events
  const handleDragOver = (e) => {
    e.preventDefault();
    // Don't allow drag when loading
    if (isLoading) return;
    setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragOver(false);

    // Don't allow drop when loading
    if (isLoading) return;

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      await processFile(e.dataTransfer.files[0]);
    }
  };

  return (
    <div
      className={`file-upload-input ${isDragOver ? 'drag-over' : ''} ${isLoading ? 'loading' : ''} ${className || ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleBrowseClick}
    >
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".mp4,.mpeg,.mpg,.mov,.avi,.flv,.webm,.wmv,.3gp,.3gpp,.mp3,.wav,.aiff,.aac,.ogg,.flac"
        className="hidden-file-input"
      />

      {isLoading ? (
        <div className="upload-content loading">
          <LoadingIndicator
            theme="dark"
            showContainer={true}
            size={48}
            className="file-upload-loading"
          />
          <h3>{t('fileUpload.processing', 'Processing media...')}</h3>
          <p>{t('fileUpload.pleaseWait', 'Please wait while we process your file')}</p>
        </div>
      ) : !uploadedFile ? (
        <div className="upload-content">
          <svg className="upload-icon" viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" strokeWidth="1" fill="none">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
          <h3>{t('inputMethods.dragDropText')}</h3>
          <p>{t('inputMethods.orText')}</p>
          <p className="browse-text">{t('inputMethods.browse')}</p>
        </div>
      ) : (
        <div className="file-info-card">
          {fileInfo && isVideoFile(fileInfo.type) ? (
            <svg className="file-type-icon video" viewBox="0 0 24 24" width="32" height="32" stroke="currentColor" strokeWidth="1.5" fill="none">
              <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
              <line x1="7" y1="2" x2="7" y2="22"></line>
              <line x1="17" y1="2" x2="17" y2="22"></line>
              <line x1="2" y1="12" x2="22" y2="12"></line>
              <line x1="2" y1="7" x2="7" y2="7"></line>
              <line x1="2" y1="17" x2="7" y2="17"></line>
              <line x1="17" y1="17" x2="22" y2="17"></line>
              <line x1="17" y1="7" x2="22" y2="7"></line>
            </svg>
          ) : (
            <svg className="file-type-icon audio" viewBox="0 0 24 24" width="32" height="32" stroke="currentColor" strokeWidth="1.5" fill="none">
              <path d="M9 18V5l12-2v13"></path>
              <circle cx="6" cy="18" r="3"></circle>
              <circle cx="18" cy="16" r="3"></circle>
            </svg>
          )}

          <div className="file-info-content">
            <h4 className="file-name">{fileInfo ? fileInfo.name : 'File'}</h4>
            <span className="file-badge">{fileInfo ? fileInfo.mediaType : 'Video'}</span>
            <span className="file-info-size">{fileInfo ? fileInfo.size : ''}</span>

            {fileInfo && (fileInfo.converting || fileInfo.copying) ? (
              <div className="converting-indicator">
                <LoadingIndicator
                  theme="dark"
                  showContainer={false}
                  size={16}
                  className="file-converting-loading"
                  style={{ marginRight: '6px' }}
                />
                {fileInfo.converting
                  ? t('fileUpload.processing', 'Processing media...')
                  : fileInfo.copying
                    ? `${t('fileUpload.copying', 'Copying large file...')} ${fileInfo.copyProgress || 0}%`
                    : t('fileUpload.processing', 'Processing media...')
                }
              </div>
            ) : (
              <button
                className="remove-file-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setFileInfo(null);
                  setUploadedFile(null);

                  // Revoke and clear current file URL
                  const existingUrl = localStorage.getItem('current_file_url');
                  if (existingUrl) {
                    try { URL.revokeObjectURL(existingUrl); } catch {}
                    localStorage.removeItem('current_file_url');
                  }

                  // Clear only session pointers; preserve gemini_file_* caches for reuse
                  try {
                    localStorage.removeItem('current_file_cache_id');
                    localStorage.removeItem('current_video_url');
                  } catch {}

                  // Preserve subtitles_data for SRT-only mode; clear only transient latest segment output
                  try {
                    localStorage.removeItem('latest_segment_subtitles');
                  } catch {}

                  // Also reset any segment UI state if handlers provided
                  try {
                    if (setVideoSegments) setVideoSegments([]);
                    if (setSegmentsStatus) setSegmentsStatus([]);
                  } catch {}

                  // If there are still subtitles to work with, switch to SRT-only mode
                  const subtitlesData = localStorage.getItem('subtitles_data');
                  if (subtitlesData && setIsSrtOnlyMode) {
                    setIsSrtOnlyMode(true);
                  }
                }}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
                {t('fileUpload.remove', 'Remove')}
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="error-message">
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};

export default FileUploadInput;
