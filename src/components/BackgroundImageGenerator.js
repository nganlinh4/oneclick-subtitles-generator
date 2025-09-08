import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FiImage, FiUpload, FiRefreshCw, FiDownload, FiX, FiAlertTriangle, FiChevronDown } from 'react-icons/fi';
import '../styles/BackgroundImageGenerator.css';
import BackgroundPromptEditorButton from './background/BackgroundPromptEditorButton';
import LoadingIndicator from './common/LoadingIndicator';
import CustomScrollbarTextarea from './common/CustomScrollbarTextarea';
import CustomDropdown from './common/CustomDropdown';

import { generateBackgroundPrompt, generateBackgroundImage } from '../services/gemini/imageGenerationService';



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
  const [customLyrics, setCustomLyrics] = useState(lyrics || '');
  const [customAlbumArt, setCustomAlbumArt] = useState(albumArt || '');
  const [generatedPrompt, setGeneratedPrompt] = useState('');
  const [generatedImage, setGeneratedImage] = useState('');
  // Initialize generatedImages from localStorage if available
  const [generatedImages, setGeneratedImages] = useState(() => {
    try {
      const savedImages = localStorage.getItem('background_generated_images');
      return savedImages ? JSON.parse(savedImages) : [];
    } catch (error) {
      console.error('Error loading generated images from localStorage:', error);
      return [];
    }
  });
  const [regularImageCount, setRegularImageCount] = useState(1);
  const [newPromptImageCount, setNewPromptImageCount] = useState(4); // Default to 4 for new prompt
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [, setPendingImageCount] = useState(0); // Track how many images are pending
  const [error, setError] = useState('');
  const [customSongName, setCustomSongName] = useState(songName || '');
  const [autoExecutionComplete, setAutoExecutionComplete] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(!isExpanded); // Use the isExpanded prop
  const [isGenerationInProgress, setIsGenerationInProgress] = useState(false); // Track if generation is in progress
  const [userHasCollapsed, setUserHasCollapsed] = useState(false); // Track if user has manually collapsed
  const [shouldAutoGenerate, setShouldAutoGenerate] = useState(false); // Track if we should auto-generate

  // Use a ref to track if the auto-execution effect has already run
  // This helps prevent double execution in React StrictMode
  const autoExecutionRef = useRef(false);

  // Ref for the Generate with Unique Prompts button
  const generateWithUniquePromptsButtonRef = useRef(null);

  // Generate prompt using Gemini
  const generatePrompt = async () => {
    if (!customLyrics.trim()) {
      setError('Please provide lyrics to generate a prompt');
      return;
    }

    setIsGeneratingPrompt(true);
    setIsGenerationInProgress(true); // Set generation in progress flag
    setError('');

    try {
      const prompt = await generateBackgroundPrompt(customLyrics, customSongName || songName || 'Unknown Song');
      setGeneratedPrompt(prompt);
      return prompt;
    } catch (err) {
      setError(`Error generating prompt: ${err.message}`);
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
      setError('Please generate a prompt first');
      return;
    }

    if (!customAlbumArt) {
      setError('Please provide album art to generate an image');
      return;
    }

    setIsGeneratingImage(true);
    setIsGenerationInProgress(true); // Set generation in progress flag
    setError('');

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
          // Mark this image as failed
          newImages[i] = {
            url: null,
            timestamp: new Date().getTime(),
            prompt: currentPrompt,
            isLoading: false,
            error: err.message
          };
          setGeneratedImages([...newImages]);
          setPendingImageCount(prev => prev - 1);
          console.error(`Error generating image ${i+1}:`, err);
        }
      }

      return newImages.filter(img => img.url !== null);
    } catch (err) {
      setError(`Error generating images: ${err.message}`);
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

  // Save generated images to localStorage whenever they change
  useEffect(() => {
    if (generatedImages.length > 0) {
      try {
        localStorage.setItem('background_generated_images', JSON.stringify(generatedImages));

      } catch (error) {
        console.error('Error saving generated images to localStorage:', error);
      }
    }
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
        setError('');
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
      setError('Please provide lyrics to generate a prompt');
      return;
    }

    if (!customAlbumArt) {
      setError('Please provide album art to generate an image');
      return;
    }

    const imagesToGenerate = count || newPromptImageCount;

    // Prepare the grid with placeholders
    setIsGeneratingImage(true);
    setIsGenerationInProgress(true); // Set generation in progress flag
    setPendingImageCount(imagesToGenerate);
    setError('');

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
          // Mark this image as failed
          newImages[i] = {
            url: null,
            timestamp: new Date().getTime(),
            prompt: newImages[i].prompt || 'Failed to generate prompt',
            isLoading: false,
            error: err.message
          };
          setGeneratedImages([...newImages]);
          setPendingImageCount(prev => prev - 1);
          console.error(`Error generating image ${i+1}:`, err);
        }
      }
    } catch (err) {
      setError(`Error in multi-prompt generation: ${err.message}`);
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
  const clearGeneratedImages = () => {
    setGeneratedImages([]);
    setGeneratedImage('');
    localStorage.removeItem('background_generated_images');

  };

  return (
    <div className={`background-generator-container ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="background-generator-header">
        <div className="header-left">
          <h2>{t('backgroundGenerator.title', 'Background Image Generator')}</h2>
          <BackgroundPromptEditorButton />
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
          <FiChevronDown />
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
                    <FiRefreshCw />
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
                    <FiUpload size={20} />
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
                    <FiDownload size={20} />
                  </button>

                </>
              ) : (
                <>
                  <div className="upload-placeholder">
                    <FiImage size={36} />
                    <p>{t('backgroundGenerator.noAlbumArt', 'No album art')}</p>
                  </div>
                  {/* Floating upload button even when no image */}
                  <label className="floating-upload-button" title={t('backgroundGenerator.uploadAlbumArt', 'Upload Album Art')}>
                    <FiUpload size={20} />
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
                <FiUpload />
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
                      <FiX size={16} />
                      <span>{t('backgroundGenerator.clearImages', 'Clear')}</span>
                    </button>
                  )}
                  {generatedImages.length > 1 && (
                    <button className="header-download-button" onClick={downloadAllImages} title={t('backgroundGenerator.downloadAllImages', 'Download All Images')}>
                      <FiDownload size={16} />
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
                      <FiRefreshCw />
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
                      <FiRefreshCw />
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
                              <FiDownload size={20} />
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
                          <div className="error-placeholder">
                            <FiAlertTriangle size={36} />
                            <p>{t('backgroundGenerator.generationFailed', 'Generation failed')}</p>
                          </div>
                        ) : (
                          <div className="preview-placeholder">
                            <FiImage size={36} />
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
                  <FiDownload size={20} />
                </button>
              </div>
            ) : (
              <div className="image-preview">
                <div className="preview-placeholder">
                  <FiImage size={48} />
                  <p>{t('backgroundGenerator.noGeneratedImage', 'No image generated yet')}</p>
                </div>
              </div>
            )}
            {/* Image actions moved to header */}
          </div>
        </div>

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
      )}
    </div>
  );
};

export default BackgroundImageGenerator;
