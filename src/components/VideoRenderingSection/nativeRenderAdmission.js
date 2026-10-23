// Render-queue admission: checks the native runtime, resolves the source and its project, durably
// flushes the project scene, and builds the exact native request one queue item will render.
import {
  buildNativeRenderRequest,
  ensureNativeRenderProject,
  getNativeRenderStatus,
  resolveNativeRenderSource,
} from '../../platform/renderService';
import { requireGeneratedNarrationArtifact } from './useNarration';

/**
 * Throws a user-presentable error (with a `code` where the caller distinguishes it) on refusal.
 * `setStage` receives each admission stage in order, before the stage's work starts.
 */
export const admitNativeRender = async ({
  t,
  selectedVideoFile,
  flushProjectRenderScene,
  getSubtitlesForSource,
  getNarrationArtifactId,
  setStage,
}) => {
  setStage('runtime');
  const runtime = await getNativeRenderStatus();
  if (!runtime.available) {
    const error = new Error(t(
      'videoRendering.rendererNotInstalled',
      'The video renderer is not ready. Install the native tools in Settings before rendering.',
    ));
    error.code = 'renderRuntimeUnavailable';
    throw error;
  }
  setStage('source');
  const nativeSourceAsset = await resolveNativeRenderSource(selectedVideoFile);
  setStage('project');
  const projectId = await ensureNativeRenderProject(nativeSourceAsset);
  const durableScene = await flushProjectRenderScene();
  if (durableScene === null
      || durableScene.projectId !== projectId) {
    const sceneError = new Error(
      'The active project render settings are not ready for this video',
    );
    sceneError.code = 'projectRenderSceneUnavailable';
    throw sceneError;
  }
  const lyrics = getSubtitlesForSource(durableScene.selectedSubtitles);
  if (!Array.isArray(lyrics) || lyrics.length === 0) {
    const subtitleError = new Error(t(
      'videoRendering.noSubtitlesSelected',
      'Add or generate subtitles before rendering.',
    ));
    subtitleError.code = 'noSubtitlesSelected';
    throw subtitleError;
  }
  setStage('narration');
  const narrationArtifactId = requireGeneratedNarrationArtifact(
    durableScene.selectedNarration,
    durableScene.selectedNarration === 'generated'
      ? await getNarrationArtifactId(durableScene.selectedNarration)
      : null,
  );
  setStage('request');
  const nativeRenderRequest = buildNativeRenderRequest({
    sourceAsset: nativeSourceAsset,
    projectId,
    sceneRevision: durableScene.sceneRevision,
    selectedSubtitles: durableScene.selectedSubtitles,
    selectedNarration: durableScene.selectedNarration,
    narrationArtifactId,
    lyrics,
    settings: durableScene.renderSettings,
    customization: durableScene.customization,
    crop: durableScene.crop,
  });
  return { nativeSourceAsset, nativeRenderRequest, durableScene, lyrics };
};
