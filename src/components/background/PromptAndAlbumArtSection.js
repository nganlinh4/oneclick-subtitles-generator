import { useTranslation } from 'react-i18next';
import LoadingIndicator from '../common/LoadingIndicator';
import CustomScrollbarTextarea from '../common/CustomScrollbarTextarea';

/**
 * The right-side input section: song name, generated prompt, and the
 * album-art uploader/preview. State and setters are passed in as props.
 */
const PromptAndAlbumArtSection = ({
  currentTheme,
  customSongName,
  setCustomSongName,
  customLyrics,
  generatedPrompt,
  setGeneratedPrompt,
  customAlbumArt,
  setCustomAlbumArt,
  isGeneratingPrompt,
  generatePrompt,
}) => {
  const { t } = useTranslation();

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

  return (
    <>
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
    </>
  );
};

export default PromptAndAlbumArtSection;
