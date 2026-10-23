// The project render scene's value contract: strict normalization of the persisted UI scene
// through the native render normalizers, and the small snapshot/tree helpers the authority shares.
import { defaultCustomization } from '../components/subtitleCustomization/defaultCustomization';
import {
  DEFAULT_CROP_SETTINGS,
  DEFAULT_RENDER_SETTINGS,
} from '../components/VideoRenderingSection/renderPreferences';
import { PROJECT_SUBTITLE_FONT_ADMISSION } from '../services/projectSubtitleFontRepair';
import { isUuidV7 } from './projectSnapshotAdapter';
import {
  normalizeNativeRenderCrop,
  normalizeNativeRenderSettings,
  normalizeNativeSubtitleCustomization,
} from './renderRequest';

export const PROJECT_RENDER_SCENE_SCHEMA_VERSION = 1;
export const PROJECT_RENDER_SCENE_DEBOUNCE_MS = 175;

const SCENE_VALUE_KEYS = Object.freeze([
  'selectedSubtitles', 'selectedNarration', 'renderSettings', 'customization', 'crop',
]);
const SCENE_RESPONSE_KEYS = Object.freeze([
  'schemaVersion', 'projectId', 'sceneRevision', ...SCENE_VALUE_KEYS,
]);
const RENDER_SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_RENDER_SETTINGS));
const CUSTOMIZATION_KEYS = Object.freeze(Object.keys(defaultCustomization));
const CROP_KEYS = Object.freeze(Object.keys(DEFAULT_CROP_SETTINGS));
export const FONT_ADMISSION_KEYS = Object.freeze(['status', 'repair', 'resolution']);
export const FONT_REPAIR_KEYS = Object.freeze(['from', 'to', 'reason']);
export const FONT_SELECTION_KEYS = Object.freeze(['fontFamily', 'fontWeight']);
const SUBTITLE_SOURCES = new Set(['original', 'translated']);
const NARRATION_SOURCES = new Set(['none', 'generated']);

export class ProjectRenderSceneError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectRenderSceneError';
    this.code = code;
    Object.assign(this, details);
  }
}

const invalidScene = (message = 'The project render scene is invalid') => (
  new ProjectRenderSceneError('invalidProjectRenderScene', message)
);

export const invalidHostScene = () => new ProjectRenderSceneError(
  'invalidProjectRenderSceneResponse',
  'The desktop host returned an invalid project render scene',
);

export const plainSnapshot = (value) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
    )) return null;
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    );
  } catch {
    return null;
  }
};

export const exactSnapshot = (value, keys) => {
  const snapshot = plainSnapshot(value);
  if (snapshot === null || Object.keys(snapshot).length !== keys.length
      || !keys.every((key) => Object.hasOwn(snapshot, key))) return null;
  return snapshot;
};

export const freezeTree = (value) => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeTree);
  return Object.freeze(value);
};

export const cloneTree = (value) => {
  if (Array.isArray(value)) return value.map(cloneTree);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneTree(child)]));
  }
  return value;
};

export const sameValues = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export const valuesOf = (scene) => Object.fromEntries(
  SCENE_VALUE_KEYS.map((key) => [key, scene[key]]),
);

export const defaultProjectRenderSceneValues = () => freezeTree({
  selectedSubtitles: 'original',
  selectedNarration: 'none',
  renderSettings: { ...DEFAULT_RENDER_SETTINGS },
  customization: { ...defaultCustomization },
  crop: { ...DEFAULT_CROP_SETTINGS },
});

/**
 * Strictly own the exact UI scene that both the render-tab preview and export consume.
 *
 * The three native normalizers are the export boundary's own validators. We convert the settings
 * timestamps back to seconds only because React's trim control is denominated in seconds; no value
 * is repaired or defaulted here. Missing, unknown, hostile-accessor and out-of-range values refuse.
 */
export const normalizeProjectRenderSceneValues = (candidate) => {
  const scene = exactSnapshot(candidate, SCENE_VALUE_KEYS);
  if (scene === null
      || !SUBTITLE_SOURCES.has(scene.selectedSubtitles)
      || !NARRATION_SOURCES.has(scene.selectedNarration)) throw invalidScene();

  const rawSettings = exactSnapshot(scene.renderSettings, RENDER_SETTING_KEYS);
  const rawCustomization = exactSnapshot(scene.customization, CUSTOMIZATION_KEYS);
  const rawCrop = exactSnapshot(scene.crop, CROP_KEYS);
  if (rawSettings === null || rawCustomization === null || rawCrop === null
      || rawSettings.videoType !== 'Subtitled Video') throw invalidScene();

  let settings;
  let customization;
  let crop;
  try {
    settings = normalizeNativeRenderSettings(rawSettings);
    customization = normalizeNativeSubtitleCustomization(rawCustomization);
    crop = normalizeNativeRenderCrop(rawCrop);
  } catch (cause) {
    throw new ProjectRenderSceneError(
      'invalidProjectRenderScene',
      'The project render scene contains a value the native renderer cannot use',
      { cause },
    );
  }

  return freezeTree({
    selectedSubtitles: scene.selectedSubtitles,
    selectedNarration: scene.selectedNarration,
    renderSettings: {
      resolution: settings.resolution,
      frameRate: settings.frameRate,
      videoType: 'Subtitled Video',
      originalAudioVolume: settings.originalAudioVolume,
      narrationVolume: settings.narrationVolume,
      trimStart: settings.trimStartUs / 1_000_000,
      trimEnd: settings.trimEndUs === null ? 0 : settings.trimEndUs / 1_000_000,
    },
    customization: { ...customization },
    crop: { ...crop },
  });
};

export const normalizeProjectRenderScene = (candidate) => {
  const response = exactSnapshot(candidate, SCENE_RESPONSE_KEYS);
  if (response === null
      || response.schemaVersion !== PROJECT_RENDER_SCENE_SCHEMA_VERSION
      || !isUuidV7(response.projectId)
      || !Number.isSafeInteger(response.sceneRevision)
      || response.sceneRevision < 0) throw invalidHostScene();
  const values = normalizeProjectRenderSceneValues(valuesOf(response));
  return freezeTree({
    schemaVersion: PROJECT_RENDER_SCENE_SCHEMA_VERSION,
    projectId: response.projectId,
    sceneRevision: response.sceneRevision,
    ...values,
  });
};

export const sceneResponse = (projectId, sceneRevision, values) => freezeTree({
  schemaVersion: PROJECT_RENDER_SCENE_SCHEMA_VERSION,
  projectId,
  sceneRevision,
  ...values,
});

export const activeProjectId = (snapshot) => {
  const id = plainSnapshot(plainSnapshot(snapshot)?.metadata)?.id;
  return isUuidV7(id) ? id : null;
};

export const inactiveView = Object.freeze({
  status: 'inactive', projectId: null, scene: null, error: null, dirty: false, fontRepair: null,
});

export const admittedFont = () => Object.freeze({
  status: PROJECT_SUBTITLE_FONT_ADMISSION.ready,
  repair: null,
  resolution: null,
});
