import { useTranslation } from 'react-i18next';
import LoadingIndicator from '../common/LoadingIndicator';
import CustomDropdown from '../common/CustomDropdown';
import { clearBackgroundImages } from '../../utils/indexedDBUtils';

/**
 * The generated-image section: image grid, generation buttons, and
 * download/clear logic. State and handlers are passed in as props.
 */
const ImageGenerationSection = ({
  currentTheme,
  generatedImage,
  setGeneratedImage,
  generatedImages,
  setGeneratedImages,
  generatedPrompt,
  customLyrics,
  customAlbumArt,
  isGeneratingPrompt,
  isGeneratingImage,
  regularImageCount,
  newPromptImageCount,
  handleRegularImageCountChange,
  handleNewPromptImageCountChange,
  generateImage,
  generateWithNewPrompt,
  generateWithUniquePromptsButtonRef,
}) => {
  const { t } = useTranslation();

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
  );
};

export default ImageGenerationSection;
