import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { isNativeMediaDescriptor, selectMedia } from '../../platform/mediaService';
import {
  clearActiveMediaSource,
  updateActiveMedia,
} from '../../platform/activeMediaSource';
import { clearSubtitleProjectBinding } from '../../platform/subtitleProjectBinding';
import LoadingIndicator from '../common/LoadingIndicator';
import { activateOnKey } from '../../utils/a11y/activateOnKey';
import { isVideoFile } from './mediaFileTypes';
import { releaseSelectedNativeMedia } from './nativeMediaSelection';
import useNativeMediaInput from './useNativeMediaInput';
import '../../styles/FileUploadInput.css';

const FileUploadInput = ({ uploadedFile, setUploadedFile, setUploadedFileData, onVideoSelect, className, isSrtOnlyMode, setIsSrtOnlyMode, setStatus }) => {
  const { t } = useTranslation();
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const dropZoneRef = useRef(null);
  const { activateNativeMedia, nativeOperationRef } = useNativeMediaInput({
    dropZoneRef,
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

  // Open the native media picker
  const handleBrowseClick = async () => {
    // Don't allow clicking when loading
    if (isLoading) return;

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
  };

  const handleRemoveFile = async (event) => {
    event.stopPropagation();
    const operation = ++nativeOperationRef.current;
    setIsLoading(true);
    let removedSession = null;
    try {
      removedSession = await releaseSelectedNativeMedia({
        media: uploadedFile,
      });
    } catch (error) {
      if (nativeOperationRef.current === operation) {
        if (isNativeMediaDescriptor(error?.restoredMedia)) {
          setUploadedFile(error.restoredMedia);
          if (setUploadedFileData) setUploadedFileData(null);
          updateActiveMedia({ playbackUrl: error.restoredMedia.playbackUrl });
        }
        const message = error?.message || t('fileUpload.releaseError', 'Could not release the selected media.');
        if (setStatus) setStatus({ message, type: 'error' });
        else if (window.addToast) window.addToast(message, 'error', 8000);
        setIsLoading(false);
      }
      return;
    }
    if (nativeOperationRef.current !== operation) return;

    if (setUploadedFileData) setUploadedFileData(null);
    setUploadedFile(null);
    if (removedSession !== null) {
      clearSubtitleProjectBinding({
        expectedCacheId: removedSession.cacheId,
        expectedProjectId: removedSession.projectId,
      });
    }

    clearActiveMediaSource();

    setIsLoading(false);
  };

  return (
    <div
      ref={dropZoneRef}
      className={`file-upload-input ${isDragOver ? 'drag-over' : ''} ${isLoading ? 'loading' : ''} ${className || ''}`}
      onClick={handleBrowseClick}
      onKeyDown={activateOnKey}
      role="button"
      tabIndex={0}
      aria-busy={isLoading || undefined}
    >

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
          <span aria-hidden="true" className="material-symbols-rounded upload-icon" style={{ fontSize: 48, display: 'inline-block' }}>
            music_video
          </span>
          <h3>{t('inputMethods.dragDropText')}</h3>
          <p>{t('inputMethods.orText')}</p>
          <p className="browse-text">{t('inputMethods.browse')}</p>
        </div>
      ) : (
        <div className="file-info-card">
          {fileInfo && isVideoFile(fileInfo.type, fileInfo.name) ? (
            <span aria-hidden="true" className="material-symbols-rounded file-type-icon video" style={{ fontSize: 32, display: 'inline-block' }}>
              videocam
            </span>
          ) : (
            <span aria-hidden="true" className="material-symbols-rounded file-type-icon audio" style={{ fontSize: 32, display: 'inline-block' }}>
              audiotrack
            </span>
          )}

          <div className="file-info-content">
            <h4 className="file-name">{fileInfo ? fileInfo.name : t('fileUpload.fileFallback', 'File')}</h4>
            <div className="file-details">
              <span className="file-badge">{fileInfo ? fileInfo.mediaType : t('fileUpload.videoFallback', 'Video')}</span>
              <span className="file-info-size">{fileInfo ? fileInfo.size : ''}</span>
            </div>

          </div>

          {fileInfo ? (
            <button
              className="remove-file-btn"
              onClick={handleRemoveFile}
            >
              <span aria-hidden="true" className="material-symbols-rounded" style={{ fontSize: 16, display: 'inline-block' }}>
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
