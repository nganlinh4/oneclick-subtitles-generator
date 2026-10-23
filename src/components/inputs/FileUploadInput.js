import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { isDesktopRuntime } from '../../platform/desktopRuntime';
import { isNativeMediaDescriptor, selectMedia } from '../../platform/mediaService';
import {
  forgetBrowserMediaBlob,
  registerBrowserMediaBlob,
} from '../../platform/browserMediaBlobRegistry';
import { clearSubtitleProjectBinding } from '../../platform/subtitleProjectBinding';
import LoadingIndicator from '../common/LoadingIndicator';
import { isAudioFile, isVideoFile, MAX_FILE_SIZE_MB } from './mediaFileTypes';
import { releaseSelectedNativeMedia } from './nativeMediaSelection';
import useNativeMediaInput from './useNativeMediaInput';
import '../../styles/FileUploadInput.css';

const FileUploadInput = ({ uploadedFile, setUploadedFile, setUploadedFileData, onVideoSelect, className, isSrtOnlyMode, setIsSrtOnlyMode, setStatus, setVideoSegments, setSegmentsStatus }) => {
  const { t } = useTranslation();
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const fileInputRef = useRef(null);
  const { activateNativeMedia, nativeOperationRef } = useNativeMediaInput({
    fileInputRef,
    isLoading,
    isSrtOnlyMode,
    onVideoSelect,
    setIsDragOver,
    setIsLoading,
    setIsSrtOnlyMode,
    setStatus,
    setUploadedFile,
    setUploadedFileData,
    t,
  });

  // Media owns its metadata. A second state copy kept A's name/type when the parent selected B.
  const fileInfo = uploadedFile ? {
    name: uploadedFile.name,
    type: uploadedFile.type,
    size: `${(uploadedFile.size / (1024 * 1024)).toFixed(2)} MB`,
    mediaType: isVideoFile(uploadedFile.type, uploadedFile.name) ? 'Video' : 'Audio',
  } : null;

  // Validate file type and size
  const validateFile = (file) => {
    // Check file size
    const fileSizeMB = file.size / (1024 * 1024);
    if (fileSizeMB > MAX_FILE_SIZE_MB) {
      window.addToast(t('fileUpload.sizeError', 'File size exceeds the maximum limit of {{size}} MB.', { size: MAX_FILE_SIZE_MB }), 'error', 5000);
      return false;
    }

    // Check file type (with fallback to extension check)
    if (!isVideoFile(file.type, file.name) && !isAudioFile(file.type, file.name)) {
      window.addToast(t('fileUpload.formatError', 'Unsupported file format. Please upload a supported video or audio file.'), 'error', 5000);
      return false;
    }

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
          const previousUrl = localStorage.getItem('current_file_url');
          if (previousUrl?.startsWith('blob:')) {
            URL.revokeObjectURL(previousUrl);
            forgetBrowserMediaBlob(previousUrl);
          }
          localStorage.removeItem('current_file_url');
        }

        // No longer converting audio files to video - keep original files as-is
        const processedFile = file;

        // Create a new object URL for the processed file
        const objectUrl = URL.createObjectURL(processedFile);
        localStorage.setItem('current_file_url', objectUrl);
        registerBrowserMediaBlob(objectUrl, processedFile);

        // Clear any selected YouTube video state via parent callback
        if (onVideoSelect) {
          onVideoSelect(null);
        }

        // If we're in SRT-only mode, switch to normal mode since we now have a video
        if (isSrtOnlyMode && setIsSrtOnlyMode) {
          setIsSrtOnlyMode(false);
        }

        // Store the processed file for actual processing
        if (setUploadedFileData) setUploadedFileData(null);
        setUploadedFile(processedFile);

        // Clear loading state after processing is complete
        setIsLoading(false);
      } else {
        setUploadedFile(null);
        // Clear the file input value to allow re-uploading the same file
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        if (localStorage.getItem('current_file_url')) {
          const previousUrl = localStorage.getItem('current_file_url');
          if (previousUrl?.startsWith('blob:')) {
            URL.revokeObjectURL(previousUrl);
            forgetBrowserMediaBlob(previousUrl);
          }
          localStorage.removeItem('current_file_url');
        }
        // Clear loading state if validation fails
        setIsLoading(false);
      }
    }
  };

  // Trigger file input click
  const handleBrowseClick = async () => {
    // Don't allow clicking when loading
    if (isLoading) return;

    if (isDesktopRuntime()) {
      const operation = ++nativeOperationRef.current;
      setIsLoading(true);
      try {
        const media = await selectMedia();
        const isCurrent = () => nativeOperationRef.current === operation;
        if (media && isCurrent()) await activateNativeMedia(media, isCurrent);
      } catch (error) {
        if (nativeOperationRef.current === operation) {
          const message = error?.message || t('fileUpload.nativeSelectionError', 'Could not open the selected media.');
          if (setStatus) setStatus({ message, type: 'error' });
          else if (window.addToast) window.addToast(message, 'error', 8000);
        }
      } finally {
        if (nativeOperationRef.current === operation) setIsLoading(false);
      }
      return;
    }

    fileInputRef.current?.click();
  };

  const handleRemoveFile = async (event) => {
    event.stopPropagation();
    const operation = ++nativeOperationRef.current;
    setIsLoading(true);
    const desktopRuntime = isDesktopRuntime();
    let removedSession = null;
    if (desktopRuntime) {
      try {
        removedSession = await releaseSelectedNativeMedia({
          media: uploadedFile,
        });
      } catch (error) {
        if (nativeOperationRef.current === operation) {
          if (isNativeMediaDescriptor(error?.restoredMedia)) {
            setUploadedFile(error.restoredMedia);
            if (setUploadedFileData) setUploadedFileData(null);
            localStorage.setItem('current_file_url', error.restoredMedia.playbackUrl);
          }
          const message = error?.message || t('fileUpload.releaseError', 'Could not release the selected media.');
          if (setStatus) setStatus({ message, type: 'error' });
          else if (window.addToast) window.addToast(message, 'error', 8000);
          setIsLoading(false);
        }
        return;
      }
    }
    if (nativeOperationRef.current !== operation) return;

    if (setUploadedFileData) setUploadedFileData(null);
    setUploadedFile(null);
    if (!desktopRuntime) {
      clearSubtitleProjectBinding();
    } else if (removedSession !== null) {
      clearSubtitleProjectBinding({
        expectedCacheId: removedSession.cacheId,
        expectedProjectId: removedSession.projectId,
      });
    }

    if (fileInputRef.current) fileInputRef.current.value = '';

    const existingUrl = localStorage.getItem('current_file_url');
    if (existingUrl?.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(existingUrl);
      } catch {
        // A stale object URL is already inert.
      }
      forgetBrowserMediaBlob(existingUrl);
    }
    localStorage.removeItem('current_file_url');

    try {
      localStorage.removeItem('current_file_cache_id');
      localStorage.removeItem('current_video_url');
      localStorage.removeItem('latest_segment_subtitles');
    } catch {
      // Storage cleanup is best effort when the WebView is shutting down.
    }

    try {
      if (setVideoSegments) setVideoSegments([]);
      if (setSegmentsStatus) setSegmentsStatus([]);
    } catch {
      // Parent teardown may make these optional setters unavailable.
    }

    setIsLoading(false);
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
        accept=".mp4,.mpeg,.mpg,.mov,.avi,.flv,.webm,.wmv,.3gp,.3gpp,.mp3,.wav,.aiff,.aac,.ogg,.flac,.m4a,.wma,.opus,.amr,.au,.caf,.dts,.ac3,.ape,.mka,.ra"
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
          <h3 style={{marginTop: '10px'}}>{t('fileUpload.processing', 'Processing media...')}</h3>
          <p>{t('fileUpload.pleaseWait', 'Please wait while we process your file')}</p>
        </div>
      ) : !uploadedFile ? (
        <div className="upload-content">
          <span className="material-symbols-rounded upload-icon" style={{ fontSize: 48, display: 'inline-block' }}>
            music_video
          </span>
          <h3>{t('inputMethods.dragDropText')}</h3>
          <p>{t('inputMethods.orText')}</p>
          <p className="browse-text">{t('inputMethods.browse')}</p>
        </div>
      ) : (
        <div className="file-info-card">
          {fileInfo && isVideoFile(fileInfo.type, fileInfo.name) ? (
            <span className="material-symbols-rounded file-type-icon video" style={{ fontSize: 32, display: 'inline-block' }}>
              videocam
            </span>
          ) : (
            <span className="material-symbols-rounded file-type-icon audio" style={{ fontSize: 32, display: 'inline-block' }}>
              audiotrack
            </span>
          )}

          <div className="file-info-content">
            <h4 className="file-name">{fileInfo ? fileInfo.name : 'File'}</h4>
            <div className="file-details">
              <span className="file-badge">{fileInfo ? fileInfo.mediaType : 'Video'}</span>
              <span className="file-info-size">{fileInfo ? fileInfo.size : ''}</span>
            </div>

          </div>

          {fileInfo ? (
            <button
              className="remove-file-btn"
              onClick={handleRemoveFile}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16, display: 'inline-block' }}>
                close
              </span>
              {t('fileUpload.remove', 'Remove')}
            </button>
          ) : null}
        </div>
      )}

    </div>
  );
};

export default FileUploadInput;
