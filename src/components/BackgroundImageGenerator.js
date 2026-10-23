import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/BackgroundImageGenerator.css';
import CustomScrollbarTextarea from './common/CustomScrollbarTextarea';
import { useCurrentTheme } from './background/themeHook';
import { boundedBackgroundErrorCode, getFriendlyErrorMessage } from './background/errorMessages';
import PromptAndAlbumArtSection from './background/PromptAndAlbumArtSection';
import ImageGenerationSection from './background/ImageGenerationSection';

import { generateBackgroundPrompt, generateBackgroundImage } from '../services/gemini/imageGenerationService';
import { saveBackgroundImages } from '../utils/indexedDBUtils';
import { isDesktopRuntime } from '../platform/runtimeEnvironment';
import { releaseNativeGeneratedImagePlayback } from '../platform/nativeGeminiImage';
import { browserViewImage, nativeViewImage, releaseNativeImages } from './background/generatedImageViews';
import {
  assertPromptProjectAuthority,
  capturePromptProjectAuthority,
} from './background/promptProjectAuthority';
import BackgroundGeneratorHeader from './background/BackgroundGeneratorHeader';
import useGeneratedImageLibrary from './background/useGeneratedImageLibrary';

/**
 * Component for generating background images based on lyrics and album art
 */
const BackgroundImageGenerator = ({ lyrics, albumArt, songName, isExpanded = false, onExpandChange }) => {
  const { t } = useTranslation();
  const currentTheme = useCurrentTheme();

  const [customLyrics, setCustomLyrics] = useState(lyrics || '');
  const [customAlbumArt, setCustomAlbumArt] = useState(albumArt || '');
  const [generatedPrompt, setGeneratedPrompt] = useState('');
  const [generatedImage, setGeneratedImage] = useState('');
  // Browser builds reopen IndexedDB; desktop builds reopen the active project's native artifacts.
  const [generatedImages, setGeneratedImages] = useState([]);
  const [regularImageCount, setRegularImageCount] = useState(1);
  const [newPromptImageCount, setNewPromptImageCount] = useState(4); // Default to 4 for new prompt
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [, setPendingImageCount] = useState(0); // Track how many images are pending
  const [customSongName, setCustomSongName] = useState(songName || '');
  const [isCollapsed, setIsCollapsed] = useState(!isExpanded); // Use the isExpanded prop
  const [userHasCollapsed, setUserHasCollapsed] = useState(false); // Track if user has manually collapsed

  const generationRunRef = useRef(0);
  const generationAbortRef = useRef(null);
  const nativeImagesRef = useRef([]);
  const sourceInputsRef = useRef(null);
  const generatedPromptDeliveryRef = useRef(null);
  const consumedPromptDeliveriesRef = useRef(new Set());

  // A prompt delivery is consumed only after the native image worker has returned its durable
  // project artifact. A lost acknowledgement response is retryable: keep the exact delivery
  // closure and drain it again after the next durable image instead of turning a real image into a
  // false generation failure.
  const acknowledgeConsumedPromptDeliveries = async (delivery = null) => {
    if (delivery !== null) consumedPromptDeliveriesRef.current.add(delivery);
    for (const pending of [...consumedPromptDeliveriesRef.current]) {
      try {
        await pending.acknowledge();
        consumedPromptDeliveriesRef.current.delete(pending);
        if (generatedPromptDeliveryRef.current?.delivery === pending) {
          generatedPromptDeliveryRef.current = null;
        }
      } catch (error) {
        console.error('The durable background-prompt acknowledgement remains pending:', error);
      }
    }
  };

  const updateGeneratedPromptFromUser = (value) => {
    generatedPromptDeliveryRef.current = null;
    setGeneratedPrompt(value);
  };

  useGeneratedImageLibrary({
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
  });

  // Ref for the Generate with Unique Prompts button
  const generateWithUniquePromptsButtonRef = useRef(null);

  // Generate prompt using Gemini
  const generatePrompt = async () => {
    if (!customLyrics.trim()) {
      window.addToast('Please provide lyrics to generate a prompt', 'error', 5000);
      return;
    }

    setIsGeneratingPrompt(true);

    try {
      const authority = capturePromptProjectAuthority();
      const result = await generateBackgroundPrompt(
        customLyrics,
        customSongName || songName || 'Unknown Song',
        authority ?? undefined,
      );
      assertPromptProjectAuthority(authority);
      setGeneratedPrompt(result.text);
      generatedPromptDeliveryRef.current = result.delivery === null
        ? null
        : Object.freeze({ text: result.text, delivery: result.delivery });
      return result.text;
    } catch (err) {
      window.addToast(getFriendlyErrorMessage(t, err), 'error', 5000);
      console.error('Error generating prompt:', err);
      return null;
    } finally {
      setIsGeneratingPrompt(false);
    }
  };

  // Places one finished image into its grid slot. Slot 0 also feeds the single-image view.
  const publishGeneratedImage = (newImages, index, generated) => {
    newImages[index] = {
      ...generated,
    };
    nativeImagesRef.current = newImages.filter((entry) => entry?.nativeImage);
    setGeneratedImages([...newImages]);
    if (index === 0) {
      setGeneratedImage(generated.url);
    }
    setPendingImageCount(prev => prev - 1);
  };

  // Generate image using Gemini
  const generateImage = async (promptToUse = null, count = null) => {
    const currentPrompt = promptToUse || generatedPrompt;
    const promptDelivery = promptToUse === null
      && generatedPromptDeliveryRef.current?.text === currentPrompt
      ? generatedPromptDeliveryRef.current.delivery
      : null;
    const imagesToGenerate = count || regularImageCount;

    if (!currentPrompt.trim()) {
      window.addToast('Please generate a prompt first', 'error', 5000);
      return;
    }

    if (!customAlbumArt) {
      window.addToast('Please provide album art to generate an image', 'error', 5000);
      return;
    }

    setIsGeneratingImage(true);
    generationAbortRef.current?.abort();
    const controller = new AbortController();
    generationAbortRef.current = controller;
    const run = generationRunRef.current + 1;
    generationRunRef.current = run;

    if (isDesktopRuntime()) {
      const previous = nativeImagesRef.current;
      nativeImagesRef.current = [];
      await releaseNativeImages(previous);
    }
    if (controller.signal.aborted || generationRunRef.current !== run) return null;

    // Prepare the grid with placeholders
    setPendingImageCount(imagesToGenerate);

    // Create placeholder array
    const placeholders = Array(imagesToGenerate).fill(null).map((_, index) => ({
      url: null,
      timestamp: new Date().getTime() + index,
      prompt: currentPrompt,
      isLoading: true
    }));

    setGeneratedImages(placeholders);

    try {
      // Generate each image one by one
      const newImages = [...placeholders];

      for (let i = 0; i < imagesToGenerate; i++) {
        try {
          const image = await generateBackgroundImage(currentPrompt, customAlbumArt, {
            signal: controller.signal,
          });
          const nativeRuntime = isDesktopRuntime();
          if (nativeRuntime && promptDelivery !== null) {
            await acknowledgeConsumedPromptDeliveries(promptDelivery);
          }
          if (generationRunRef.current !== run || controller.signal.aborted) {
            if (nativeRuntime) {
              await releaseNativeGeneratedImagePlayback(image).catch(() => undefined);
            }
            break;
          }
          const generated = nativeRuntime
            ? nativeViewImage(image, currentPrompt)
            : browserViewImage(image, currentPrompt);

          publishGeneratedImage(newImages, i, generated);
        } catch (err) {
          if (controller.signal.aborted
              || generationRunRef.current !== run
              || err?.name === 'AbortError') {
            break;
          }
          // Show error toast notification
          window.addToast(getFriendlyErrorMessage(t, err), 'error', 5000);
          // Mark this image as failed
          newImages[i] = {
            url: null,
            timestamp: new Date().getTime(),
            prompt: currentPrompt,
            isLoading: false,
            error: true,
            errorCode: boundedBackgroundErrorCode(err),
          };
          setGeneratedImages([...newImages]);
          setPendingImageCount(prev => prev - 1);
          console.error(`Error generating image ${i+1}:`, err);
        }
      }

      return newImages.filter(img => img.url !== null);
    } catch (err) {
      if (controller.signal.aborted || generationRunRef.current !== run || err?.name === 'AbortError') {
        return null;
      }
      window.addToast(getFriendlyErrorMessage(t, err), 'error', 5000);
      console.error('Error in image generation process:', err);
      return null;
    } finally {
      if (generationRunRef.current === run) {
        if (generationAbortRef.current === controller) generationAbortRef.current = null;
        setIsGeneratingImage(false);
      }
    }
  };

  // Sync isCollapsed state with isExpanded prop, but respect user's manual collapse
  useEffect(() => {
    // Always expand when isExpanded becomes true, regardless of userHasCollapsed
    if (isExpanded) {
      setIsCollapsed(false);
      // Reset userHasCollapsed when we force expand
      setUserHasCollapsed(false);
    }
    // Only collapse if the user hasn't manually collapsed it
    else if (!userHasCollapsed) {
      setIsCollapsed(true);
    }
  }, [isExpanded, userHasCollapsed]);

  // Save generated images to IndexedDB whenever they change
  useEffect(() => {
    if (isDesktopRuntime()) return undefined;
    const saveImages = async () => {
      try {
        await saveBackgroundImages(generatedImages);
      } catch (error) {
        console.error('Error saving generated images to IndexedDB:', error);
      }
    };

    // Only save if we have images or if we're clearing them (empty array)
    void saveImages();
    return undefined;
  }, [generatedImages]);

  // Update state when lyrics or albumArt props change, but preserve generated images
  useEffect(() => {
    const previous = sourceInputsRef.current;
    const next = { lyrics, albumArt, songName: songName || '' };
    const sourceChanged = previous === null
      || previous.lyrics !== next.lyrics
      || previous.albumArt !== next.albumArt
      || previous.songName !== next.songName;
    sourceInputsRef.current = next;
    if (!sourceChanged) return;

    if (lyrics && albumArt) {
      // Update the custom values
      setCustomLyrics(lyrics);
      setCustomAlbumArt(albumArt);
      setCustomSongName(songName || '');

      // Only reset generated content if the source content has changed
      if (previous !== null) {
        generatedPromptDeliveryRef.current = null;
        setGeneratedPrompt('');
        setGeneratedImage('');
        // Don't reset generatedImages to preserve them across UI changes
        setPendingImageCount(0);
      }

      // Only expand if the user hasn't manually collapsed it
      if (!userHasCollapsed) {
        setIsCollapsed(false); // Expand when new content is provided

        // Notify parent component about expansion
        if (onExpandChange) {
          onExpandChange(true);
        }
      }
    }
  }, [lyrics, albumArt, songName, onExpandChange, userHasCollapsed]);

  // Generate new prompt and then generate image
  const generateWithNewPrompt = async (count = null) => {
    if (!customLyrics.trim()) {
      window.addToast('Please provide lyrics to generate a prompt', 'error', 5000);
      return;
    }

    if (!customAlbumArt) {
      window.addToast('Please provide album art to generate an image', 'error', 5000);
      return;
    }

    const imagesToGenerate = count || newPromptImageCount;

    // Prepare the grid with placeholders
    setIsGeneratingImage(true);
    setPendingImageCount(imagesToGenerate);
    generationAbortRef.current?.abort();
    const controller = new AbortController();
    generationAbortRef.current = controller;
    const run = generationRunRef.current + 1;
    generationRunRef.current = run;

    if (isDesktopRuntime()) {
      const previous = nativeImagesRef.current;
      nativeImagesRef.current = [];
      await releaseNativeImages(previous);
    }
    if (controller.signal.aborted || generationRunRef.current !== run) return;

    // Create placeholder array
    const placeholders = Array(imagesToGenerate).fill(null).map((_, index) => ({
      url: null,
      timestamp: new Date().getTime() + index,
      prompt: '',  // Will be filled with a unique prompt for each image
      isLoading: true
    }));

    setGeneratedImages(placeholders);

    try {
      // Generate each image with its own unique prompt
      const newImages = [...placeholders];

      for (let i = 0; i < imagesToGenerate; i++) {
        try {
          // Generate a new prompt for each image
          setIsGeneratingPrompt(true);

          const authority = capturePromptProjectAuthority();
          const promptResult = await generateBackgroundPrompt(
            customLyrics,
            customSongName || songName || 'Unknown Song',
            authority ?? undefined,
          );
          assertPromptProjectAuthority(authority);
          const uniquePrompt = promptResult.text;
          if (controller.signal.aborted || generationRunRef.current !== run) break;

          // Update the prompt in the UI for the latest generated prompt
          setGeneratedPrompt(uniquePrompt);
          setIsGeneratingPrompt(false);

          // Update the placeholder with the new prompt
          newImages[i] = {
            ...newImages[i],
            prompt: uniquePrompt
          };
          setGeneratedImages([...newImages]);

          // Generate image with the unique prompt
          const image = await generateBackgroundImage(uniquePrompt, customAlbumArt, {
            signal: controller.signal,
          });
          const nativeRuntime = isDesktopRuntime();
          if (nativeRuntime && promptResult.delivery !== null) {
            await acknowledgeConsumedPromptDeliveries(promptResult.delivery);
          }
          if (generationRunRef.current !== run || controller.signal.aborted) {
            if (nativeRuntime) {
              await releaseNativeGeneratedImagePlayback(image).catch(() => undefined);
            }
            break;
          }
          const generated = nativeRuntime
            ? nativeViewImage(image, uniquePrompt)
            : browserViewImage(image, uniquePrompt);

          publishGeneratedImage(newImages, i, generated);
        } catch (err) {
          if (controller.signal.aborted
              || generationRunRef.current !== run
              || err?.name === 'AbortError') {
            break;
          }
          // Show error toast notification
          window.addToast(getFriendlyErrorMessage(t, err), 'error', 5000);
          // Mark this image as failed
          newImages[i] = {
            url: null,
            timestamp: new Date().getTime(),
            prompt: newImages[i].prompt || 'Failed to generate prompt',
            isLoading: false,
            error: true,
            errorCode: boundedBackgroundErrorCode(err),
          };
          setGeneratedImages([...newImages]);
          setPendingImageCount(prev => prev - 1);
          console.error(`Error generating image ${i+1}:`, err);
        }
      }
    } catch (err) {
      if (controller.signal.aborted || generationRunRef.current !== run || err?.name === 'AbortError') {
        return;
      }
      window.addToast(getFriendlyErrorMessage(t, err), 'error', 5000);
      console.error('Error in multi-prompt generation process:', err);
    } finally {
      if (generationRunRef.current === run) {
        if (generationAbortRef.current === controller) generationAbortRef.current = null;
        setIsGeneratingPrompt(false);
        setIsGeneratingImage(false);
      }
    }
  };

  // Handle image count selection for regular generation
  const handleRegularImageCountChange = (count) => {
    setRegularImageCount(parseInt(count, 10));
  };

  // Handle image count selection for new prompt generation
  const handleNewPromptImageCountChange = (count) => {
    setNewPromptImageCount(parseInt(count, 10));
  };

  // Toggle collapsed state - ONLY affects visual display, not generation
  const handleToggleCollapsed = () => {
    const newCollapsedState = !isCollapsed;
    setIsCollapsed(newCollapsedState);

    // Set userHasCollapsed flag when user manually collapses
    if (newCollapsedState) {
      setUserHasCollapsed(true);
    } else {
      // Reset the flag when user manually expands
      setUserHasCollapsed(false);
    }

    // Notify parent component about expansion/collapse
    if (onExpandChange) {
      onExpandChange(!newCollapsedState);
    }
  };

  return (
    <div className={`background-generator-container ${isCollapsed ? 'collapsed' : ''}`}>
      <BackgroundGeneratorHeader
        isCollapsed={isCollapsed}
        onToggleCollapsed={handleToggleCollapsed}
      />

      {isCollapsed ? (
        <div className="background-generator-collapsed-content">
          <p className="helper-message">
            {t('backgroundGenerator.helperMessage', 'You can use your custom lyrics and album art here or press "Thêm phụ đề" and fetch from Genius')}
          </p>
        </div>
      ) : (
        <div className="background-generator-content">
          {/* First row: Lyrics input on left, song name and prompt in middle, album art on right */}
          <div className="content-grid top-inputs-grid">
          {/* Lyrics input */}
          <div className="lyrics-input-container">
            <CustomScrollbarTextarea
              value={customLyrics}
              onChange={(e) => setCustomLyrics(e.target.value)}
              placeholder={t('backgroundGenerator.lyricsPlaceholder', 'Enter lyrics here...')}
              rows={6}
              containerClassName="large"
              style={{ minHeight: '150px' }}
            />
          </div>

          <PromptAndAlbumArtSection
            currentTheme={currentTheme}
            customSongName={customSongName}
            setCustomSongName={setCustomSongName}
            customLyrics={customLyrics}
            generatedPrompt={generatedPrompt}
            setGeneratedPrompt={updateGeneratedPromptFromUser}
            customAlbumArt={customAlbumArt}
            setCustomAlbumArt={setCustomAlbumArt}
            isGeneratingPrompt={isGeneratingPrompt}
            generatePrompt={generatePrompt}
          />
        </div>

        {/* Second row: Generated image */}
        <ImageGenerationSection
          currentTheme={currentTheme}
          generatedImage={generatedImage}
          setGeneratedImage={setGeneratedImage}
          generatedImages={generatedImages}
          setGeneratedImages={setGeneratedImages}
          generatedPrompt={generatedPrompt}
          customLyrics={customLyrics}
          customAlbumArt={customAlbumArt}
          isGeneratingPrompt={isGeneratingPrompt}
          isGeneratingImage={isGeneratingImage}
          regularImageCount={regularImageCount}
          newPromptImageCount={newPromptImageCount}
          handleRegularImageCountChange={handleRegularImageCountChange}
          handleNewPromptImageCountChange={handleNewPromptImageCountChange}
          generateImage={generateImage}
          generateWithNewPrompt={generateWithNewPrompt}
          generateWithUniquePromptsButtonRef={generateWithUniquePromptsButtonRef}
        />

        </div>
      )}
    </div>
  );
};

export default BackgroundImageGenerator;
