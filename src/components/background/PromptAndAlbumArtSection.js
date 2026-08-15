import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import LoadingIndicator from '../common/LoadingIndicator';
import CustomScrollbarTextarea from '../common/CustomScrollbarTextarea';
import {
  exportReferenceImagePlayback,
  releaseReferenceImagePlayback,
  selectReferenceImagePlayback,
} from '../../platform/imageService';
import { getActiveGeneratedImageProjectId } from '../../platform/nativeGeminiImage';
import { isDesktopRuntime } from '../../platform/runtimeEnvironment';
import { showErrorToast } from '../../utils/toastUtils';

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
  const localPlaybackRef = useRef(null);
  const selectionRunRef = useRef(0);
  const albumArtValueRef = useRef(customAlbumArt);
  albumArtValueRef.current = customAlbumArt;

  useEffect(() => {
    const owned = localPlaybackRef.current;
    if (owned && customAlbumArt !== owned.playbackUrl) {
      localPlaybackRef.current = null;
      selectionRunRef.current += 1;
      void releaseReferenceImagePlayback({
        playbackId: owned.id,
        projectId: owned.projectId,
      }).catch(() => undefined);
    }
  }, [customAlbumArt]);

  useEffect(() => () => {
    selectionRunRef.current += 1;
    const owned = localPlaybackRef.current;
    localPlaybackRef.current = null;
    if (owned) {
      void releaseReferenceImagePlayback({
        playbackId: owned.id,
        projectId: owned.projectId,
      }).catch(() => undefined);
    }
  }, []);

  const handleNativeAlbumArtSelect = async () => {
    const run = selectionRunRef.current + 1;
    selectionRunRef.current = run;
    const startingAlbumArt = albumArtValueRef.current;
    let selected = null;
    const discardSelected = async () => {
      const discard = selected;
      selected = null;
      if (discard) {
        await releaseReferenceImagePlayback({
          playbackId: discard.id,
          projectId: discard.projectId,
        }).catch(() => undefined);
      }
    };
    try {
      const capturedProjectId = await getActiveGeneratedImageProjectId();
      selected = await selectReferenceImagePlayback(capturedProjectId);
      if (!selected) return;
      const confirmedProjectId = await getActiveGeneratedImageProjectId();
      if (confirmedProjectId !== capturedProjectId
          || selectionRunRef.current !== run
          || albumArtValueRef.current !== startingAlbumArt) {
        await discardSelected();
        return;
      }
      const previous = localPlaybackRef.current;
      const installed = selected;
      selected = null;
      localPlaybackRef.current = installed;
      setCustomAlbumArt(installed.playbackUrl);
      if (previous && previous.id !== installed.id) {
        await releaseReferenceImagePlayback({
          playbackId: previous.id,
          projectId: previous.projectId,
        }).catch(() => undefined);
      }
    } catch (error) {
      await discardSelected();
      console.error('Album art selection failed:', error);
      showErrorToast(error?.message || 'The album art could not be selected.', 8000);
    }
  };

  const handleAlbumArtExport = async () => {
    try {
      if (!isDesktopRuntime()) {
        const { exportGeneratedResource } = await import('../../platform/generatedFileExportService');
        await exportGeneratedResource(customAlbumArt, 'album-art.png');
        return;
      }
      const projectId = await getActiveGeneratedImageProjectId();
      await exportReferenceImagePlayback(customAlbumArt, projectId, 'album-art.png');
    } catch (error) {
      console.error('Album art export failed:', error);
      showErrorToast(error?.message || 'The album art could not be saved.', 8000);
    }
  };

  const uploadControl = (className) => {
    if (!isDesktopRuntime()) {
      return (
        <label className={className} title={t('backgroundGenerator.uploadAlbumArt', 'Upload Album Art')}>
          <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>upload</span>
          {className === 'upload-button' && (
            <span>{t('backgroundGenerator.uploadAlbumArt', 'Upload Album Art')}</span>
          )}
          <input
            type="file"
            accept=".png,.jpg,.jpeg,.webp,.gif"
            onChange={(event) => {
              const file = event.target.files[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = (loadEvent) => {
                setCustomAlbumArt(loadEvent.target.result);
              };
              reader.readAsDataURL(file);
            }}
            style={{ display: 'none' }}
          />
        </label>
      );
    }
    return (
      <button
        type="button"
        className={className}
        title={t('backgroundGenerator.uploadAlbumArt', 'Upload Album Art')}
        onClick={handleNativeAlbumArtSelect}
      >
        <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>upload</span>
        {className === 'upload-button' && (
          <span>{t('backgroundGenerator.uploadAlbumArt', 'Upload Album Art')}</span>
        )}
      </button>
    );
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
              {uploadControl('floating-upload-button')}
              {/* Floating download button */}
              <button
                className="floating-download-button"
                onClick={() => { void handleAlbumArtExport(); }}
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
              {uploadControl('floating-upload-button')}
            </>
          )}
        </div>
        {/* Keep the original actions div for backward compatibility, but it's hidden via CSS */}
        <div className="album-art-actions">
          {uploadControl('upload-button')}
        </div>
      </div>
    </>
  );
};

export default PromptAndAlbumArtSection;
