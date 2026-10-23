/**
 * Lifecycle of the background generator's image library: reopen saved images when the sources or
 * the active project change, cancel in-flight generation on a project switch, and release native
 * playback capabilities on unmount. Browser builds reopen IndexedDB instead.
 */
import { useEffect, useState } from 'react';

import {
  getActiveGeneratedImageProjectId,
  loadNativeGeneratedImages,
} from '../../platform/nativeGeminiImage';
import { isDesktopRuntime } from '../../platform/runtimeEnvironment';
import { loadBackgroundImages } from '../../utils/indexedDBUtils';
import { subscribeCurrentCacheId } from '../../utils/userSubtitlesStore';
import { nativeViewImage, releaseNativeImages } from './generatedImageViews';

const useGeneratedImageLibrary = ({
  lyrics,
  albumArt,
  songName,
  generationRunRef,
  generationAbortRef,
  nativeImagesRef,
  generatedPromptDeliveryRef,
  setGeneratedImages,
  setGeneratedImage,
  setIsGeneratingPrompt,
  setIsGeneratingImage,
  setPendingImageCount,
}) => {
  const [activeProjectGeneration, setActiveProjectGeneration] = useState(0);

  useEffect(() => subscribeCurrentCacheId(() => {
    if (isDesktopRuntime()) {
      generationRunRef.current += 1;
      generationAbortRef.current?.abort();
      generationAbortRef.current = null;
      generatedPromptDeliveryRef.current = null;
      setActiveProjectGeneration((generation) => generation + 1);
    }
  }), [generatedPromptDeliveryRef, generationAbortRef, generationRunRef]);

  // Native images are reopened from the active durable project. The legacy browser build keeps
  // its IndexedDB behavior, but capability URLs are never written there.
  useEffect(() => {
    let disposed = false;
    const loadGeneration = generationRunRef.current + 1;
    generationRunRef.current = loadGeneration;
    generationAbortRef.current?.abort();
    generationAbortRef.current = null;
    setIsGeneratingPrompt(false);
    setIsGeneratingImage(false);
    setPendingImageCount(0);

    const loadImages = async () => {
      let pendingNativeImages = [];
      try {
        if (!isDesktopRuntime()) {
          const savedImages = await loadBackgroundImages();
          if (!disposed && generationRunRef.current === loadGeneration) {
            setGeneratedImages(savedImages);
            setGeneratedImage(savedImages.find((image) => image?.url)?.url || '');
          }
          return;
        }

        const previous = nativeImagesRef.current;
        nativeImagesRef.current = [];
        setGeneratedImages([]);
        setGeneratedImage('');
        await releaseNativeImages(previous);
        const projectId = await getActiveGeneratedImageProjectId();
        const reopened = await loadNativeGeneratedImages(projectId);
        pendingNativeImages = reopened.map((image) => nativeViewImage(image));
        const currentProjectId = await getActiveGeneratedImageProjectId().catch(() => null);
        if (disposed
            || generationRunRef.current !== loadGeneration
            || currentProjectId !== projectId) {
          await releaseNativeImages(pendingNativeImages);
          pendingNativeImages = [];
          return;
        }
        const views = pendingNativeImages;
        pendingNativeImages = [];
        nativeImagesRef.current = views;
        setGeneratedImages(views);
        setGeneratedImage(views[0]?.url || '');
      } catch (error) {
        await releaseNativeImages(pendingNativeImages);
        if (!disposed && error?.code !== 'imageProjectUnavailable' && error?.code !== 'invalidImageProject') {
          console.error('Error loading generated images:', error);
        }
      }
    };

    void loadImages();
    return () => {
      disposed = true;
    };
  }, [
    activeProjectGeneration,
    albumArt,
    lyrics,
    songName,
    // Refs and state setters are identity-stable; listed only to satisfy the hook linter.
    generationAbortRef,
    generationRunRef,
    nativeImagesRef,
    setGeneratedImage,
    setGeneratedImages,
    setIsGeneratingImage,
    setIsGeneratingPrompt,
    setPendingImageCount,
  ]);

  useEffect(() => () => {
    generationRunRef.current += 1;
    generationAbortRef.current?.abort();
    void releaseNativeImages(nativeImagesRef.current);
    nativeImagesRef.current = [];
  }, [generationAbortRef, generationRunRef, nativeImagesRef]);
};

export default useGeneratedImageLibrary;
