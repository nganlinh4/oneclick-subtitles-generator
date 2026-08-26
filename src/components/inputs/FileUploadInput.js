import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isDesktopRuntime } from '../../platform/desktopRuntime';
import { nativeMediaDropService, sharedNativeMediaDropService } from '../../platform/mediaDropService';
import { isPhysicalPointInsideElement } from '../../platform/nativeMediaDropTarget';
import {
  ensureProjectOwnsNativeMedia,
  forgetNativeMediaSessionDurably,
  loadDurableNativeMediaSession,
  readNativeMediaSession,
  resolveOwnedNativeMediaProject,
} from '../../platform/nativeMediaOwnership';
import { applyNativeMediaSession } from '../../hooks/useNativeMediaSessionHydration';
import {
  claimMediaDrop,
  clearMedia,
  getSelectedMedia,
  isNativeMediaDescriptor,
  isNativeMediaPlaybackUrl,
  restoreMediaAsset,
  selectMedia,
} from '../../platform/mediaService';
import {
  forgetBrowserMediaBlob,
  registerBrowserMediaBlob,
} from '../../platform/browserMediaBlobRegistry';
import {
  activateSubtitleProjectBinding,
  clearSubtitleProjectBinding,
} from '../../platform/subtitleProjectBinding';
import LoadingIndicator from '../common/LoadingIndicator';
import '../../styles/FileUploadInput.css';

export const reconcileSelectedNativeMedia = async ({
  media,
  activateAsLocal,
  applyOwnedSession,
  readSession = readNativeMediaSession,
  resolveOwner = resolveOwnedNativeMediaProject,
}) => {
  const session = readSession();
  if (session === null) {
    await activateAsLocal(media);
    return 'local';
  }
  if (session.assetId !== media?.assetId) {
    throw new Error('The selected media does not match its active subtitle project.');
  }
  const owner = await resolveOwner(session);
  if (owner === null) {
    throw new Error('The selected media subtitle project is no longer available.');
  }
  await applyOwnedSession(media, session);
  return 'owned-session';
};

export const releaseSelectedNativeMedia = async ({
  media,
  clear = clearMedia,
  readSession = readNativeMediaSession,
  forgetSession = forgetNativeMediaSessionDurably,
  restore = restoreMediaAsset,
}) => {
  if (!isNativeMediaDescriptor(media)
      || typeof clear !== 'function'
      || typeof readSession !== 'function'
      || typeof forgetSession !== 'function'
      || typeof restore !== 'function') {
    throw new TypeError('Exact native media is required for release');
  }
  const session = readSession();
  await clear({
    expectedAssetId: media.assetId,
    expectedPlaybackId: media.playbackId,
  });
  if (session === null || session.assetId !== media.assetId) return null;
  if (await forgetSession({ expectedSession: session }) === true) return session;

  const current = readSession();
  if (current === null
      || current.assetId !== session.assetId
      || current.cacheId !== session.cacheId
      || current.projectId !== session.projectId) {
    return null;
  }

  // The native capability has already been withdrawn, but its exact durable pointer survived.
  // Reopen only if the host is still empty: a newer selection arriving after `clear` must win.
  // Refusing the UI removal after this rollback keeps the visible state and relaunch state equal.
  const restored = await restore(media.assetId);
  if (restored === null) return null;
  if (!isNativeMediaDescriptor(restored)
      || restored.assetId !== media.assetId) {
    throw new Error('The selected media could not be restored after its session remained active.');
  }
  throw Object.assign(new Error('The selected media session could not be removed.'), {
    restoredMedia: restored,
  });
};

const FileUploadInput = ({ uploadedFile, setUploadedFile, setUploadedFileData, onVideoSelect, className, isSrtOnlyMode, setIsSrtOnlyMode, setStatus, setVideoSegments, setSegmentsStatus }) => {
  const { t } = useTranslation();
  const [fileInfo, setFileInfo] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const fileInputRef = useRef(null);

  const lastSelectedFileRef = useRef(null);
  const nativeOperationRef = useRef(0);
  const nativeHydratedRef = useRef(false);
  const nativeLoadingRef = useRef(false);


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

  const SUPPORTED_AUDIO_EXTENSIONS = useMemo(() => [
    ".wav", ".mp3", ".aiff", ".aac", ".ogg", ".flac", ".m4a", ".wma", ".opus",
    ".amr", ".au", ".caf", ".dts", ".ac3", ".ape", ".mka", ".ra", ".webm"
  ], []);

  const SUPPORTED_VIDEO_EXTENSIONS = useMemo(() => [
    ".mp4", ".mpeg", ".mpg", ".mov", ".avi", ".flv", ".webm", ".wmv", ".3gp", ".3gpp"
  ], []);

  // Check if file is a video - wrapped in useCallback to avoid dependency issues
  const isVideoFile = useCallback((mimeType, fileName = '') => {
    // First check MIME type
    if (SUPPORTED_VIDEO_FORMATS.includes(mimeType)) {
      return true;
    }
    // Fallback to file extension check
    const extension = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
    return SUPPORTED_VIDEO_EXTENSIONS.includes(extension);
  }, [SUPPORTED_VIDEO_FORMATS, SUPPORTED_VIDEO_EXTENSIONS]);

  // Check if file is an audio - wrapped in useCallback to avoid dependency issues
  const isAudioFile = useCallback((mimeType, fileName = '') => {
    // Allow any MIME type that starts with 'audio/'
    if (mimeType.startsWith('audio/')) {
      return true;
    }
    // Fallback to file extension check for known audio extensions
    const extension = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
    return SUPPORTED_AUDIO_EXTENSIONS.includes(extension);
  }, [SUPPORTED_AUDIO_EXTENSIONS]);

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
      const mediaType = isVideoFile(file.type, file.name) ? 'Video' : 'Audio';
      setFileInfo({
        name: file.name,
        type: file.type,
        size: `${fileSizeMB} MB`,
        mediaType
      });
    }
  }, [isVideoFile]);

  // `isCurrent` is re-checked after the durable ownership commit, because that await lets a newer
  // selection supersede this one before the media is published to React.
  const activateNativeMedia = useCallback(async (media, isCurrent = () => true) => {
    // A locally imported asset is its own subtitle alias. Binding it to that project durably is
    // what makes it reopenable after a restart; without it the asset is unowned forever.
    const ownership = await ensureProjectOwnsNativeMedia({ media, cacheId: media.assetId });
    if (!isCurrent()) return;
    await activateSubtitleProjectBinding(media.assetId, {
      expectedProjectId: ownership.projectId,
      create: false,
    });
    if (!isCurrent()) return;

    localStorage.removeItem('current_video_url');
    localStorage.removeItem('split_result');
    const previousUrl = localStorage.getItem('current_file_url');
    if (previousUrl?.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(previousUrl);
      } catch {
        // A stale object URL is already inert.
      }
      forgetBrowserMediaBlob(previousUrl);
    }
    localStorage.setItem('current_file_url', media.playbackUrl);

    if (onVideoSelect) onVideoSelect(null);
    if (isSrtOnlyMode && setIsSrtOnlyMode) setIsSrtOnlyMode(false);
    if (setUploadedFileData) setUploadedFileData(null);
    setUploadedFile(media);
    displayFileInfo(media);

    // Media ownership does not imply subtitle-track readiness. In particular, this callback can
    // still observe source A's React cue array while transactional activation has already made
    // source B current. The subtitle project/hydration owner publishes its own authoritative state.
  }, [
    displayFileInfo,
    isSrtOnlyMode,
    onVideoSelect,
    setIsSrtOnlyMode,
    setUploadedFile,
    setUploadedFileData,
  ]);

  useEffect(() => {
    nativeLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    if (!isDesktopRuntime()) return undefined;

    let cancelled = false;
    let subscription = null;
    let activeDragId = null;
    let lastSequence = 0;

    const containsPhysicalPosition = (position) => {
      const dropZone = fileInputRef.current?.closest('.file-upload-input');
      return isPhysicalPointInsideElement(position, dropZone);
    };

    const showNativeDropError = (error) => {
      const message = error?.message || t('fileUpload.nativeSelectionError', 'Could not open the selected media.');
      if (setStatus) setStatus({ message, type: 'error' });
      else if (window.addToast) window.addToast(message, 'error', 8000);
    };

    const handleNativeDropEvent = (event) => {
      if (cancelled || event.sequence <= lastSequence) return;
      lastSequence = event.sequence;

      if (event.type === 'enter') {
        activeDragId = event.dragId;
      } else if (activeDragId !== null && event.dragId !== activeDragId) {
        return;
      } else if (activeDragId === null && (event.type === 'over' || event.type === 'leave')) {
        return;
      }

      if (event.type === 'enter' || event.type === 'over') {
        setIsDragOver(!nativeLoadingRef.current && containsPhysicalPosition(event.position));
        return;
      }
      setIsDragOver(false);

      if (event.type === 'leave') {
        activeDragId = null;
        return;
      }
      if (event.type === 'rejected') {
        activeDragId = null;
        if (!containsPhysicalPosition(event.position)) return;
        const message = t('fileUpload.formatError', 'Unsupported file format. Please upload a supported video or audio file.');
        if (window.addToast) window.addToast(message, 'error', 5000);
        else if (setStatus) setStatus({ message, type: 'error' });
        return;
      }
      if (event.type !== 'drop') return;
      activeDragId = null;

      if (!containsPhysicalPosition(event.position)) return;
      if (nativeLoadingRef.current) {
        nativeMediaDropService.discard(event.offerId).catch(() => {});
        return;
      }

      const operation = ++nativeOperationRef.current;
      nativeLoadingRef.current = true;
      setIsLoading(true);
      claimMediaDrop(event.offerId)
        .then((media) => {
          const isCurrent = () => !cancelled && nativeOperationRef.current === operation;
          if (isCurrent()) return activateNativeMedia(media, isCurrent);
          return undefined;
        })
        .catch((error) => {
          if (!cancelled && nativeOperationRef.current === operation) showNativeDropError(error);
        })
        .finally(() => {
          if (!cancelled && nativeOperationRef.current === operation) {
            nativeLoadingRef.current = false;
            setIsLoading(false);
          }
        });
    };

    sharedNativeMediaDropService.subscribe(handleNativeDropEvent, () => {
      if (!cancelled) setIsDragOver(false);
    }).then((registered) => {
      if (cancelled) registered.unsubscribe().catch(() => {});
      else subscription = registered;
    }).catch(() => {
      if (!cancelled) setIsDragOver(false);
    });

    return () => {
      cancelled = true;
      if (subscription) subscription.unsubscribe().catch(() => {});
    };
  }, [activateNativeMedia, setStatus, t]);

  // Reconcile WebView state with Rust after remounts. Expired loopback capabilities from a prior
  // process are removed instead of being replayed as if they were still authorized.
  useEffect(() => {
    if (!isDesktopRuntime() || nativeHydratedRef.current) return undefined;
    nativeHydratedRef.current = true;
    const operation = ++nativeOperationRef.current;
    let mounted = true;

    loadDurableNativeMediaSession()
      .then(() => getSelectedMedia())
      .then((media) => {
        if (!mounted || nativeOperationRef.current !== operation) return undefined;
        if (media) {
          const isCurrent = () => mounted && nativeOperationRef.current === operation;
          return reconcileSelectedNativeMedia({
            media,
            activateAsLocal: (selected) => activateNativeMedia(selected, isCurrent),
            applyOwnedSession: async (selected, session) => {
              if (!isCurrent()) return;
              await applyNativeMediaSession({
                media: selected,
                cacheId: session.cacheId,
                projectId: session.projectId,
                setUploadedFile,
                validateOwnership: isCurrent,
              });
              if (!isCurrent()) return;
              if (onVideoSelect) onVideoSelect(null);
              if (isSrtOnlyMode && setIsSrtOnlyMode) setIsSrtOnlyMode(false);
              if (setUploadedFileData) setUploadedFileData(null);
              displayFileInfo(selected);
            },
          });
        }
        const staleUrl = localStorage.getItem('current_file_url');
        if (isNativeMediaPlaybackUrl(staleUrl)) {
          localStorage.removeItem('current_file_url');
        }
      })
      .catch((error) => {
        console.error('Could not reconcile the native media session:', error);
      });

    return () => { mounted = false; };
  }, [
    activateNativeMedia,
    displayFileInfo,
    isSrtOnlyMode,
    onVideoSelect,
    setIsSrtOnlyMode,
    setUploadedFile,
    setUploadedFileData,
  ]);

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

        // Display file info for all file types (both audio and video)
        displayFileInfo(processedFile);

        // Clear loading state after processing is complete
        setIsLoading(false);
      } else {
        setUploadedFile(null);
        setFileInfo(null);
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
            displayFileInfo(error.restoredMedia);
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

    setFileInfo(null);
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

            {fileInfo && fileInfo.copying ? (
              <div className="converting-indicator">
                <LoadingIndicator
                  theme="dark"
                  showContainer={false}
                  size={16}
                  className="file-converting-loading"
                  style={{ marginRight: '6px' }}
                />
                {`${t('fileUpload.copying', 'Copying large file...')} ${fileInfo.copyProgress || 0}%`}
              </div>
            ) : null}
          </div>

          {fileInfo && !(fileInfo.converting || fileInfo.copying) ? (
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
