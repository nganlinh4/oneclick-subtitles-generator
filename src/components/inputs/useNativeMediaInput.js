import { useCallback, useEffect, useRef } from 'react';
import { isDesktopRuntime } from '../../platform/desktopRuntime';
import { nativeMediaDropService, sharedNativeMediaDropService } from '../../platform/mediaDropService';
import { isPhysicalPointInsideElement } from '../../platform/nativeMediaDropTarget';
import {
  ensureProjectOwnsNativeMedia,
  loadDurableNativeMediaSession,
} from '../../platform/nativeMediaOwnership';
import { applyNativeMediaSession } from '../../hooks/useNativeMediaSessionHydration';
import {
  claimMediaDrop,
  getSelectedMedia,
  isNativeMediaPlaybackUrl,
} from '../../platform/mediaService';
import { forgetBrowserMediaBlob } from '../../platform/browserMediaBlobRegistry';
import { activateSubtitleProjectBinding } from '../../platform/subtitleProjectBinding';
import { reconcileSelectedNativeMedia } from './nativeMediaSelection';

/**
 * The upload input's desktop half: activating native media, the native drag-and-drop
 * subscription, and remount reconciliation with Rust. `nativeOperationRef` orders every native
 * selection, drop and release; a newer operation makes older async results inert.
 */
const useNativeMediaInput = ({
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
}) => {
  const nativeOperationRef = useRef(0);
  const nativeHydratedRef = useRef(false);
  const nativeLoadingRef = useRef(false);

  // `isCurrent` is re-checked after the durable ownership commit, because that await lets a newer
  // selection supersede this one before the media is published to React.
  const activateNativeMedia = useCallback(async (media, isCurrent = () => true) => {
    // A locally imported asset is its own subtitle alias. Binding it to that project durably is
    // what makes it reopenable after a restart; without it the asset is unowned forever.
    const ownership = await ensureProjectOwnsNativeMedia({ media, cacheId: media.assetId });
    if (!isCurrent()) return;
    await activateSubtitleProjectBinding(ownership.cacheId, {
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

    // Media ownership does not imply subtitle-track readiness. In particular, this callback can
    // still observe source A's React cue array while transactional activation has already made
    // source B current. The subtitle project/hydration owner publishes its own authoritative state.
  }, [
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
  }, [activateNativeMedia, fileInputRef, setIsDragOver, setIsLoading, setStatus, t]);

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
    isSrtOnlyMode,
    onVideoSelect,
    setIsSrtOnlyMode,
    setUploadedFile,
    setUploadedFileData,
  ]);

  return { activateNativeMedia, nativeOperationRef };
};

export default useNativeMediaInput;
