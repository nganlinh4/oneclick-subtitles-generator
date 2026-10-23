// The render tab's view of the active project's render scene: its values (defaults while it loads),
// field setters that write through the project authority, and the scene-error toast.
import { useCallback, useEffect } from 'react';

import {
  defaultProjectRenderSceneValues,
  useProjectRenderScene,
} from '../../platform/projectRenderScene';
import { completeSubtitleCustomization } from './subtitleCustomizationState';

export const useProjectRenderSceneControls = () => {
  // One project-owned scene is the only state preview, queue admission and export may read. It is
  // cleared synchronously during A→B activation, so the old project's style/trim never flashes or
  // leaks into the new project's request while Rust loads the durable scene.
  const {
    status: renderSceneStatus,
    scene: projectRenderScene,
    error: renderSceneError,
    updateScene: updateProjectRenderScene,
    flushScene: flushProjectRenderScene,
  } = useProjectRenderScene();
  useEffect(() => {
    const key = 'native-render-scene-error';
    if (!renderSceneError) {
      window.removeToastByKey?.(key);
      return;
    }
    window.addToast?.(renderSceneError.message, 'error', 8000, key);
  }, [renderSceneError]);
  const fallbackScene = defaultProjectRenderSceneValues();
  const sceneValues = projectRenderScene ?? fallbackScene;
  const {
    selectedSubtitles,
    selectedNarration,
    renderSettings,
    customization: subtitleCustomization,
    crop: cropSettings,
  } = sceneValues;

  const updateSceneField = useCallback((field, update) => {
    updateProjectRenderScene((previous) => ({
      ...previous,
      [field]: typeof update === 'function' ? update(previous[field]) : update,
    }));
  }, [updateProjectRenderScene]);
  const setSelectedSubtitles = useCallback(
    (update) => updateSceneField('selectedSubtitles', update),
    [updateSceneField],
  );
  const setSelectedNarration = useCallback(
    (update) => updateSceneField('selectedNarration', update),
    [updateSceneField],
  );
  const setRenderSettings = useCallback(
    (update) => updateSceneField('renderSettings', update),
    [updateSceneField],
  );
  const setSubtitleCustomization = useCallback(
    (update) => updateSceneField('customization', (previous) => completeSubtitleCustomization(
      typeof update === 'function' ? update(previous) : update,
    )),
    [updateSceneField],
  );
  const setCropSettings = useCallback(
    (update) => updateSceneField('crop', update),
    [updateSceneField],
  );

  return {
    renderSceneStatus,
    flushProjectRenderScene,
    selectedSubtitles,
    selectedNarration,
    renderSettings,
    subtitleCustomization,
    cropSettings,
    setSelectedSubtitles,
    setSelectedNarration,
    setRenderSettings,
    setSubtitleCustomization,
    setCropSettings,
  };
};
