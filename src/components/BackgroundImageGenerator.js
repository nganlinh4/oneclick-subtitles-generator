import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/BackgroundImageGenerator.css';
import BackgroundPromptEditorButton from './background/BackgroundPromptEditorButton';
import CustomScrollbarTextarea from './common/CustomScrollbarTextarea';
import { useCurrentTheme } from './background/themeHook';
import { getFriendlyErrorMessage } from './background/errorMessages';
import PromptAndAlbumArtSection from './background/PromptAndAlbumArtSection';
import ImageGenerationSection from './background/ImageGenerationSection';

import { generateBackgroundPrompt, generateBackgroundImage } from '../services/gemini/imageGenerationService';
import { saveBackgroundImages, loadBackgroundImages } from '../utils/indexedDBUtils';

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
  // Initialize generatedImages from IndexedDB if available
  const [generatedImages, setGeneratedImages] = useState([]);
  const [regularImageCount, setRegularImageCount] = useState(1);
  const [newPromptImageCount, setNewPromptImageCount] = useState(4); // Default to 4 for new prompt
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [, setPendingImageCount] = useState(0); // Track how many images are pending
  const [customSongName, setCustomSongName] = useState(songName || '');
  const [autoExecutionComplete, setAutoExecutionComplete] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(!isExpanded); // Use the isExpanded prop
  const [isGenerationInProgress, setIsGenerationInProgress] = useState(false); // Track if generation is in progress
  const [userHasCollapsed, setUserHasCollapsed] = useState(false); // Track if user has manually collapsed
  const [shouldAutoGenerate, setShouldAutoGenerate] = useState(false); // Track if we should auto-generate

  // Use a ref to track if the auto-execution effect has already run
  // This helps prevent double execution in React StrictMode
  const autoExecutionRef = useRef(false);

  // Load generated images from IndexedDB on component mount
  useEffect(() => {
    const loadImages = async () => {
      try {
        const savedImages = await loadBackgroundImages();
        setGeneratedImages(savedImages);
      } catch (error) {
        console.error('Error loading generated images from IndexedDB:', error);
        setGeneratedImages([]);
      }
    };

    loadImages();
  }, []);

  // Ref for the Generate with Unique Prompts button
  const generateWithUniquePromptsButtonRef = useRef(null);

  // Generate prompt using Gemini
  const generatePrompt = async () => {
    if (!customLyrics.trim()) {
      window.addToast('Please provide lyrics to generate a prompt', 'error', 5000);
      return;
    }

    setIsGeneratingPrompt(true);
    setIsGenerationInProgress(true); // Set generation in progress flag

    try {
      const prompt = await generateBackgroundPrompt(customLyrics, customSongName || songName || 'Unknown Song');
      setGeneratedPrompt(prompt);
      return prompt;
    } catch (err) {
      window.addToast(getFriendlyErrorMessage(t, err?.message || String(err)), 'error', 5000);
      console.error('Error generating prompt:', err);
      return null;
    } finally {
      setIsGeneratingPrompt(false);
      setIsGenerationInProgress(false); // Reset generation in progress flag
    }
  };

  // Generate image using Gemini
  const generateImage = async (promptToUse = null, count = null) => {
    const currentPrompt = promptToUse || generatedPrompt;
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
    setIsGenerationInProgress(true); // Set generation in progress flag

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
          const { mime_type, data } = await generateBackgroundImage(currentPrompt, customAlbumArt);
          const imageUrl = `data:${mime_type};base64,${data}`;

          // Update this specific image in the array
          newImages[i] = {
            url: imageUrl,
            timestamp: new Date().getTime(),
            prompt: currentPrompt,
            isLoading: false
          };

          // Update the state with the progress
          setGeneratedImages([...newImages]);

          // Also update the single image view for backward compatibility
          if (i === 0) {
            setGeneratedImage(imageUrl);
          }

          // Decrease pending count
          setPendingImageCount(prev => prev - 1);
        } catch (err) {
          // Show error toast notification
          window.addToast(getFriendlyErrorMessage(t, err?.message || String(err)), 'error', 5000);
          // Mark this image as failed
          newImages[i] = {
            url: null,
            timestamp: new Date().getTime(),
            prompt: currentPrompt,
            isLoading: false,
            error: true // Just mark as error, don't store the message
          };
          setGeneratedImages([...newImages]);
          setPendingImageCount(prev => prev - 1);
          console.error(`Error generating image ${i+1}:`, err);
        }
      }

      return newImages.filter(img => img.url !== null);
    } catch (err) {
      window.addToast(getFriendlyErrorMessage(t, err?.message || String(err)), 'error', 5000);
      console.error('Error in image generation process:', err);
      return null;
    } finally {
      setIsGeneratingImage(false);
      setIsGenerationInProgress(false); // Reset generation in progress flag
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
    const saveImages = async () => {
      try {
        await saveBackgroundImages(generatedImages);
      } catch (error) {
        console.error('Error saving generated images to IndexedDB:', error);
      }
    };

    // Only save if we have images or if we're clearing them (empty array)
    saveImages();
  }, [generatedImages]);

  // Update state when lyrics or albumArt props change, but preserve generated images
  useEffect(() => {
    if (lyrics && albumArt) {
      // Check if the lyrics and albumArt are different from the current ones
      const lyricsChanged = lyrics !== customLyrics;
      const albumArtChanged = albumArt !== customAlbumArt;
      const songNameChanged = (songName || '') !== customSongName;

      // Update the custom values
      setCustomLyrics(lyrics);
      setCustomAlbumArt(albumArt);
      setCustomSongName(songName || '');

      // Only reset generated content if the source content has changed
      if (lyricsChanged || albumArtChanged || songNameChanged) {

        setGeneratedPrompt('');
        setGeneratedImage('');
        // Don't reset generatedImages to preserve them across UI changes
        // setGeneratedImages([]);
        setPendingImageCount(0);
        setAutoExecutionComplete(false);
        autoExecutionRef.current = false; // Reset the ref to allow auto-execution
      }

      // Only expand if the user hasn't manually collapsed it
      if (!userHasCollapsed) {
        setIsCollapsed(false); // Expand when new content is provided

        // Notify parent component about expansion
        if (onExpandChange) {
          onExpandChange(true);
        }

        // No longer setting shouldAutoGenerate flag to prevent auto-generation
        // setShouldAutoGenerate(true); - removed to prevent auto-generation
      }
    }
  }, [lyrics, albumArt, songName, onExpandChange, userHasCollapsed, customLyrics, customAlbumArt, customSongName]);

  // Effect to handle the shouldAutoGenerate flag (auto-click functionality removed)
  useEffect(() => {
    if (shouldAutoGenerate && !isCollapsed && !isGenerationInProgress) {

      // Reset the flag to prevent multiple executions
      setShouldAutoGenerate(false);
      // No longer auto-clicking the button
    }
  }, [shouldAutoGenerate, isCollapsed, isGenerationInProgress]);

  // Auto-execute prompt generation and image generation when component mounts
  // or when lyrics/albumArt change - uses the default of 4 images for new prompt
  useEffect(() => {
    // Skip if we've already run this effect in the current render cycle
    // or if we don't have the necessary data or if auto-execution is already complete
    if (autoExecutionRef.current || autoExecutionComplete || !lyrics || !albumArt) {
      return;
    }

    // Mark that we've run this effect
    autoExecutionRef.current = true;

    /* Auto-execution is disabled, but we keep the structure for potential future use
    const executeAutoGeneration = async () => {
      // Function implementation removed for brevity
    };

    // Disabled auto-execution to prevent automatic generation when component is expanded
    // if (lyrics && albumArt && !autoExecutionComplete) {
    //   executeAutoGeneration();
    // }
    */

    // Cleanup function to reset the ref when the component unmounts
    return () => {
      // We don't reset the ref here because we want to prevent re-execution
      // even if the effect is called multiple times due to StrictMode
    };
  }, [lyrics, albumArt, customLyrics, customAlbumArt, customSongName, autoExecutionComplete]);

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
    setIsGenerationInProgress(true); // Set generation in progress flag
    setPendingImageCount(imagesToGenerate);

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


          const uniquePrompt = await generateBackgroundPrompt(customLyrics, customSongName || songName || 'Unknown Song');

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


          const { mime_type: iMime, data: iData } = await generateBackgroundImage(uniquePrompt, customAlbumArt);
          const imageUrl = `data:${iMime};base64,${iData}`;

          // Update this specific image in the array
          newImages[i] = {
            url: imageUrl,
            timestamp: new Date().getTime(),
            prompt: uniquePrompt,
            isLoading: false
          };

          // Update the state with the progress
          setGeneratedImages([...newImages]);

          // Also update the single image view for backward compatibility
          if (i === 0) {
            setGeneratedImage(imageUrl);
          }

          // Decrease pending count
          setPendingImageCount(prev => prev - 1);
        } catch (err) {
          // Show error toast notification
          window.addToast(getFriendlyErrorMessage(t, err?.message || String(err)), 'error', 5000);
          // Mark this image as failed
          newImages[i] = {
            url: null,
            timestamp: new Date().getTime(),
            prompt: newImages[i].prompt || 'Failed to generate prompt',
            isLoading: false,
            error: true // Just mark as error, don't store the message
          };
          setGeneratedImages([...newImages]);
          setPendingImageCount(prev => prev - 1);
          console.error(`Error generating image ${i+1}:`, err);
        }
      }
    } catch (err) {
      window.addToast(getFriendlyErrorMessage(t, err?.message || String(err)), 'error', 5000);
      console.error('Error in multi-prompt generation process:', err);
    } finally {
      setIsGeneratingPrompt(false);
      setIsGeneratingImage(false);
      setIsGenerationInProgress(false); // Reset generation in progress flag
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

  return (
    <div className={`background-generator-container ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="background-generator-header">
        <div className="header-left">
          <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span className="material-symbols-rounded" style={{ fontSize: '24px' }}>panorama</span>
            {t('backgroundGenerator.title', 'Background Image Generator')}
          </h2>
          <BackgroundPromptEditorButton />
          <span style={{
            marginLeft: '16px',
            fontSize: '12px',
            color: 'var(--md-on-surface-variant)',
            fontStyle: 'italic',
            opacity: 0.7
          }}>
            {t('backgroundGenerator.upcomingFeatures', 'Currently, Google has completely removed 2 native image models from the free tier!')}
          </span>
        </div>
        <button
          className="collapse-button"
          onClick={() => {
            // Toggle collapsed state - ONLY affects visual display, not generation
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


          }}
          title={isCollapsed ? t('backgroundGenerator.expand', 'Expand') : t('backgroundGenerator.collapse', 'Collapse')}
        >
          <span className="material-symbols-rounded">{isCollapsed ? 'expand_more' : 'stat_1'}</span>
        </button>
      </div>

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
            setGeneratedPrompt={setGeneratedPrompt}
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
