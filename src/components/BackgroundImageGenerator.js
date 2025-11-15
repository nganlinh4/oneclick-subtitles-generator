import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/BackgroundImageGenerator.css';
import BackgroundPromptEditorButton from './background/BackgroundPromptEditorButton';
import LoadingIndicator from './common/LoadingIndicator';
import CustomScrollbarTextarea from './common/CustomScrollbarTextarea';
import CustomDropdown from './common/CustomDropdown';

import { generateBackgroundPrompt, generateBackgroundImage } from '../services/gemini/imageGenerationService';
import { saveBackgroundImages, loadBackgroundImages, clearBackgroundImages } from '../utils/indexedDBUtils';



// Custom hook to detect current theme
const useCurrentTheme = () => {
  const [theme, setTheme] = useState(() => {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  });

  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          const newTheme = document.documentElement.getAttribute('data-theme') || 'dark';
          setTheme(newTheme);
        }
      });
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });

    // Also listen for storage events (theme changes from other tabs)
    const handleStorageChange = () => {
      const newTheme = document.documentElement.getAttribute('data-theme') || 'dark';
      setTheme(newTheme);
    };

    window.addEventListener('storage', handleStorageChange);

    return () => {
      observer.disconnect();
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  return theme;
};

/**
 * Component for generating background images based on lyrics and album art
 */
const BackgroundImageGenerator = ({ lyrics, albumArt, songName, isExpanded = false, onExpandChange }) => {
  const { t } = useTranslation();
  const currentTheme = useCurrentTheme();

  // Helper: map raw error to friendly, localized message
  const getFriendlyErrorMessage = (raw = '') => {
    const msg = String(raw || '').trim();
    const statusMatch = msg.match(/HTTP\s+(\d{3})/i);
    if (statusMatch) {
      const code = parseInt(statusMatch[1], 10);
      switch (code) {
        case 429:
          return t('backgroundGenerator.error.quotaExceeded', 'Quota exceeded. Check your plan and billing.');
        case 401:
          return t('backgroundGenerator.error.unauthorized', 'Unauthorized: API key invalid or missing.');
        case 403:
          return t('backgroundGenerator.error.forbidden', 'Access forbidden. Check billing/quota or model access.');
        case 400:
          return t('backgroundGenerator.error.badRequest', 'Invalid request. Adjust prompt or album art and try again.');
        case 413:
          return t('backgroundGenerator.error.payloadTooLarge', 'Request too large. Try a smaller album image.');
        case 415:
          return t('backgroundGenerator.error.unsupportedMediaType', 'Unsupported image type. Please upload PNG or JPEG.');
        case 500:
        case 502:
        case 503:
        case 504:
          return t('backgroundGenerator.error.serverError', 'Service is temporarily unavailable. Please try again later.');
        default:
          return t('backgroundGenerator.error.generic', 'Generation failed');
      }
    }
    if (/exceeded\s+your\s+current\s+quota/i.test(msg) || /quota/i.test(msg)) {
      return t('backgroundGenerator.error.quotaExceeded', 'Quota exceeded. Check your plan and billing.');
    }
    if (/api key not set/i.test(msg) || /api\s*key.*(invalid|missing)/i.test(msg)) {
      return t('backgroundGenerator.error.apiKeyMissing', 'Gemini API key not set. Please set it in settings.');
    }
    if (/billing/i.test(msg)) {
      return t('backgroundGenerator.error.quotaExceeded', 'Quota exceeded. Check your plan and billing.');
    }
    if (/cors|cross-origin/i.test(msg)) {
      return t('backgroundGenerator.error.cors', 'Could not load album art due to CORS. Upload the image instead.');
    }
    if (/no image returned/i.test(msg)) {
      return t('backgroundGenerator.error.noImageReturned', 'No image was returned. Try again or simplify the prompt.');
    }
    if (/no prompt returned/i.test(msg)) {
      return t('backgroundGenerator.error.noPromptReturned', 'No prompt was returned. Try again later.');
    }
    if (/network/i.test(msg)) {
      return t('backgroundGenerator.error.network', 'Network error. Check your connection and try again.');
    }
    return t('backgroundGenerator.error.generic', 'Generation failed');
  };

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
      window.addToast(getFriendlyErrorMessage(err?.message || String(err)), 'error', 5000);
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
          window.addToast(getFriendlyErrorMessage(err?.message || String(err)), 'error', 5000);
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
      window.addToast(getFriendlyErrorMessage(err?.message || String(err)), 'error', 5000);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lyrics, albumArt, customLyrics, customAlbumArt, customSongName, autoExecutionComplete]);


  // Handle file upload for custom album art
  const handleAlbumArtUpload = (event) => {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setCustomAlbumArt(e.target.result);
      };
      reader.readAsDataURL(file);
    }
  };



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
          window.addToast(getFriendlyErrorMessage(err?.message || String(err)), 'error', 5000);
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
      window.addToast(getFriendlyErrorMessage(err?.message || String(err)), 'error', 5000);
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

  // Download generated image
  const downloadImage = (imageUrl = null, index = null) => {
    // If no specific image is provided, use the main generatedImage
    const imageToDownload = imageUrl || generatedImage;
    if (!imageToDownload) return;

    const link = document.createElement('a');
    link.href = imageToDownload;
    link.download = `background-${index !== null ? index + 1 : new Date().getTime()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Download all generated images as a batch
  const downloadAllImages = () => {
    if (!generatedImages.length) return;

    // Download each image with a slight delay to prevent browser issues
    generatedImages.forEach((image, index) => {
      setTimeout(() => {
        downloadImage(image.url, index);
      }, index * 300); // 300ms delay between downloads
    });
  };

  // Clear all generated images
  const clearGeneratedImages = async () => {
    setGeneratedImages([]);
    setGeneratedImage('');
    try {
      await clearBackgroundImages();
    } catch (error) {
      console.error('Error clearing generated images from IndexedDB:', error);
    }
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

          {/* Right side container for song name and prompt */}
          <div className="right-inputs-container">
            {/* Song name input */}
            <div className="song-name-input">
              <h3>{t('backgroundGenerator.songName', 'Song Name')}</h3>
              <div className="song-name-field-container">
                <input
                  type="text"
                  value={customSongName}
                  onChange={(e) => setCustomSongName(e.target.value)}
                  placeholder={t('backgroundGenerator.songNamePlaceholder', 'Enter song name (optional)')}
                  autoComplete="off"
                />
              </div>
            </div>

            {/* Prompt section */}
            <div className="prompt-section">
              <div className="prompt-header">
                <h3>{t('backgroundGenerator.prompt', 'Generated Prompt')}</h3>
                <button
                  className={`generate-button ${isGeneratingPrompt ? 'loading' : ''}`}
                  onClick={() => generatePrompt()}
                  disabled={isGeneratingPrompt || !customLyrics.trim()}
                >
                  {isGeneratingPrompt ? (
                    <LoadingIndicator size={20} theme={currentTheme} showContainer={false} />
                  ) : (
                    <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>wand_stars</span>
                  )}
                  <span>
                    {isGeneratingPrompt
                      ? t('backgroundGenerator.generatingPrompt', 'Generating...')
                      : t('backgroundGenerator.generatePrompt', 'Generate')}
                  </span>
                </button>
              </div>
              <div className="prompt-container">
                <CustomScrollbarTextarea
                  value={generatedPrompt}
                  onChange={(e) => setGeneratedPrompt(e.target.value)}
                  placeholder={t('backgroundGenerator.promptPlaceholder', 'Generated prompt will appear here...')}
                  rows={3}
                />
              </div>
            </div>
          </div>

          {/* Album art container */}
          <div className="album-art-container">
            <h3>{t('backgroundGenerator.albumArt', 'Album Art')}</h3>
            <div className="album-art-preview">
              {customAlbumArt ? (
                <>
                  <img src={customAlbumArt} alt="Album Art" />
                  {/* Floating upload button */}
                  <label className="floating-upload-button" title={t('backgroundGenerator.uploadAlbumArt', 'Upload Album Art')}>
                    <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>upload</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleAlbumArtUpload}
                      style={{ display: 'none' }}
                    />
                  </label>
                  {/* Floating download button */}
                  <button
                    className="floating-download-button"
                    onClick={() => {
                      // Create a temporary link to download the image
                      const link = document.createElement('a');
                      link.href = customAlbumArt;
                      link.download = 'album-art.png';
                      document.body.appendChild(link);
                      link.click();
                      document.body.removeChild(link);
                    }}
                    title={t('backgroundGenerator.downloadAlbumArt', 'Download Album Art')}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>download</span>
                  </button>

                </>
              ) : (
                <>
                  <div className="upload-placeholder">
                    <span className="material-symbols-rounded" style={{ fontSize: '36px' }}>hide_image</span>
                    <p>{t('backgroundGenerator.noAlbumArt', 'No album art')}</p>
                  </div>
                  {/* Floating upload button even when no image */}
                  <label className="floating-upload-button" title={t('backgroundGenerator.uploadAlbumArt', 'Upload Album Art')}>
                    <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>upload</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleAlbumArtUpload}
                      style={{ display: 'none' }}
                    />
                  </label>
                </>
              )}
            </div>
            {/* Keep the original actions div for backward compatibility, but it's hidden via CSS */}
            <div className="album-art-actions">
              <label className="upload-button">
                <span className="material-symbols-rounded">upload</span>
                <span>{t('backgroundGenerator.uploadAlbumArt', 'Upload Album Art')}</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleAlbumArtUpload}
                  style={{ display: 'none' }}
                />
              </label>
            </div>
          </div>
        </div>

        {/* Second row: Generated image */}
        <div className="media-content-grid">

          {/* Generated image section */}
          <div className="image-section">
            <div className="image-section-header">
              <div className="image-title-container">
                <h3>{t('backgroundGenerator.generatedImage', 'Generated Image')}</h3>
                <div className="image-header-buttons">
                  {generatedImages.length > 0 && (
                    <button className="header-action-button" onClick={clearGeneratedImages} title={t('backgroundGenerator.clearImagesTitle', 'Clear All Images')}>
                      <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>close</span>
                      <span>{t('backgroundGenerator.clearImages', 'Clear')}</span>
                    </button>
                  )}
                  {generatedImages.length > 1 && (
                    <button className="header-download-button" onClick={downloadAllImages} title={t('backgroundGenerator.downloadAllImages', 'Download All Images')}>
                      <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>download</span>
                      <span>{t('backgroundGenerator.downloadAllImages', 'Download All')}</span>
                    </button>
                  )}
                </div>
              </div>
              <div className="image-header-actions">
                <div className="generate-button-group">
                  <button
                    className={`generate-button ${isGeneratingImage ? 'loading' : ''}`}
                    onClick={() => generateImage()}
                    disabled={isGeneratingImage || isGeneratingPrompt || !generatedPrompt.trim() || !customAlbumArt}
                    title={t('backgroundGenerator.generateImageTooltip', 'Generate images using the same prompt')}
                  >
                    {isGeneratingImage ? (
                      <LoadingIndicator size={20} theme={currentTheme} showContainer={false} />
                    ) : (
                      <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>image</span>
                    )}
                    <span>
                      {isGeneratingImage
                        ? t('backgroundGenerator.generatingImage', 'Generating...')
                        : t('backgroundGenerator.generateImage', 'Generate with Same Prompt')}
                    </span>
                  </button>

                  <CustomDropdown
                    className="image-count-dropdown"
                    value={String(regularImageCount)}
                    onChange={(val) => handleRegularImageCountChange(val)}
                    disabled={isGeneratingImage || isGeneratingPrompt}
                    options={[1,2,3,4,5,6,7,8].map(num => ({ value: String(num), label: String(num) }))}
                  />

                </div>

                <div className="generate-button-group">
                  <button
                    ref={generateWithUniquePromptsButtonRef}
                    className={`generate-button new-prompt-button ${isGeneratingPrompt || isGeneratingImage ? 'loading' : ''}`}
                    onClick={() => generateWithNewPrompt()}
                    disabled={isGeneratingPrompt || isGeneratingImage || !customLyrics.trim() || !customAlbumArt}
                    title={t('backgroundGenerator.generateWithNewPromptTooltip', 'Generates a unique prompt for each image')}
                  >
                    {isGeneratingPrompt || isGeneratingImage ? (
                      <LoadingIndicator size={20} theme={currentTheme} showContainer={false} />
                    ) : (
                      <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>imagesmode</span>
                    )}
                    <span>
                      {isGeneratingPrompt || isGeneratingImage
                        ? t('backgroundGenerator.generatingWithNewPrompt', 'Generating...')
                        : t('backgroundGenerator.generateWithNewPrompt', 'Generate with Unique Prompts')}
                    </span>
                  </button>

                  <CustomDropdown
                    className="image-count-dropdown"
                    value={String(newPromptImageCount)}
                    onChange={(val) => handleNewPromptImageCountChange(val)}
                    disabled={isGeneratingImage || isGeneratingPrompt}
                    options={[1,2,3,4,5,6,7,8].map(num => ({ value: String(num), label: String(num) }))}
                  />

                </div>
              </div>
            </div>
            {generatedImages.length > 0 ? (
              <>
                <div className={`image-grid image-grid-${Math.min(generatedImages.length, 4)}`}>
                  {generatedImages.map((image, index) => (
                    <div className="image-grid-item" key={index}>
                      <div className={`image-preview ${image.isLoading ? 'loading' : ''}`}>
                        {image.url ? (
                          <>
                            <img src={image.url} alt={`Generated Background ${index + 1}`} />
                            <button
                              className="floating-download-button"
                              onClick={() => downloadImage(image.url, index)}
                              title={t('backgroundGenerator.downloadImage', 'Download')}
                            >
                              <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>download</span>
                            </button>
                          </>
                        ) : image.isLoading ? (
                          <div className="loading-placeholder">
                            <LoadingIndicator
                              theme="dark"
                              showContainer={true}
                              size={64}
                              className="background-generator-loading"
                            />
                            <p>{t('backgroundGenerator.generatingImage', 'Generating...')}</p>
                          </div>
                        ) : image.error ? (
                          <div className="preview-placeholder">
                            <span className="material-symbols-rounded" style={{ fontSize: '36px' }}>error</span>
                            <p>{t('backgroundGenerator.generationFailed')}</p>
                          </div>
                        ) : (
                          <div className="preview-placeholder">
                            <span className="material-symbols-rounded" style={{ fontSize: '36px' }}>image</span>
                            <p>{t('backgroundGenerator.noGeneratedImage', 'No image generated yet')}</p>
                          </div>
                        )}
                        <div className="image-number">{index + 1}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : generatedImage ? (
              <div className="image-preview single-image">
                <img src={generatedImage} alt="Generated Background" />
                <button
                  className="floating-download-button"
                  onClick={() => downloadImage()}
                  title={t('backgroundGenerator.downloadImage', 'Download')}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>download</span>
                </button>
              </div>
            ) : (
              <div className="image-preview">
                <div className="preview-placeholder">
                  <span className="material-symbols-rounded" style={{ fontSize: '48px' }}>gallery_thumbnail</span>
                  <p>{t('backgroundGenerator.noGeneratedImage', 'No image generated yet')}</p>
                </div>
              </div>
            )}
            {/* Image actions moved to header */}
          </div>
        </div>

        </div>
      )}
    </div>
  );
};

export default BackgroundImageGenerator;
