/**
 * The editor preview's subtitle style, read from and written to the project-owned render scene.
 * Writes are queued by the scene authority; a refused write surfaces as a keyed error toast.
 */
import { useCallback, useMemo } from 'react';

import { defaultCustomization } from '../subtitleCustomization/defaultCustomization';
import {
  applyPreviewSettingsToProjectScene,
  previewSettingsFromProjectScene,
} from './projectPreviewSettings';

const reportProjectStyleFailure = (error, t) => {
  window.addToast?.(
    error?.message || t('videoPreview.projectStyleUnavailable', 'Add a video before styling subtitles.'),
    'error',
    8000,
    'project-subtitle-style',
  );
};

// The main editor and Render tab are two views of this one project-owned scene. The browser-era
// `subtitle_settings` localStorage record is deliberately not read or mirrored here: it had no
// project identity, so project B could inherit project A's style while export used a different
// SQLite scene. A loading scene shows the canonical defaults for a few milliseconds; updates made
// during loading are queued by the authority and applied to the loaded scene before publication.
const useProjectSubtitleSettings = ({ projectRenderScene, updateProjectRenderScene, t }) => {
  const subtitleSettings = useMemo(
    () => previewSettingsFromProjectScene(projectRenderScene),
    [projectRenderScene],
  );
  const handleSubtitleSettingsChange = useCallback((nextSettings) => {
    try {
      updateProjectRenderScene((previous) => (
        applyPreviewSettingsToProjectScene(previous, nextSettings)
      ));
    } catch (error) {
      reportProjectStyleFailure(error, t);
    }
  }, [t, updateProjectRenderScene]);
  const resetSubtitleSettings = useCallback(() => {
    try {
      updateProjectRenderScene((previous) => ({
        ...previous,
        selectedSubtitles: 'original',
        customization: { ...defaultCustomization },
      }));
    } catch (error) {
      reportProjectStyleFailure(error, t);
    }
  }, [t, updateProjectRenderScene]);
  return { subtitleSettings, handleSubtitleSettingsChange, resetSubtitleSettings };
};

export default useProjectSubtitleSettings;
