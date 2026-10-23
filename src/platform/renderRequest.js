// Native render request building: source-asset authority, project association, and the
// lyrics/settings/customization/crop normalizers the export and the persisted scene share.
import { subtitleDisplayText } from '../utils/subtitleSpeaker';

import { resolveActiveNativeMedia } from './activeNativeMedia';
import { isDesktopRuntime } from './desktopRuntime';
import { isNativeMediaDescriptor } from './mediaService';
import {
  canonicalAssetFromDescriptor as sharedCanonicalAssetFromDescriptor,
  readNativeMediaSession,
  resolveOwnedNativeMediaProject,
} from './nativeMediaOwnership';
import {
  invalidRequest,
  runtimeRequired,
  validateRequestPart,
} from './renderErrors';
import {
  hasControlCharacter,
  hasExactKeys,
  isPlainRecord,
  isWellFormedUtf16,
  requireBoolean,
  requireColor,
  requireEnum,
  requireFinite,
  requireGradientDirection,
  requireInteger,
  requireString,
  requireUuid,
  secondsToMicros,
  snapshotExactRecord,
  snapshotPlainRecord,
  utf8ByteLength,
  uuidHasVersion,
} from './renderValidation';

const MAX_RENDER_LYRICS = 100_000;
const MAX_TOTAL_LYRIC_BYTES = 8 * 1024 * 1024;
const RESOLUTIONS = new Set(['360p', '480p', '720p', '1080p', '1440p', '4K', '8K']);
const FRAME_RATES = new Set([24, 25, 30, 50, 60, 120]);
const SUBTITLE_SOURCES = new Set(['original', 'translated']);
const NARRATION_SOURCES = new Set(['none', 'generated']);
const AUDIO_EXTENSIONS = new Set([
  'aac', 'ac3', 'aiff', 'amr', 'ape', 'au', 'caf', 'dts', 'flac', 'm4a', 'mka', 'mp3',
  'oga', 'ogg', 'opus', 'ra', 'wav', 'weba', 'wma',
]);
const VIDEO_EXTENSIONS = new Set([
  '3gp', '3gpp', 'avi', 'flv', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm', 'wmv',
]);
const TEXT_ALIGNMENTS = new Set(['left', 'center', 'right', 'justify']);
const TEXT_TRANSFORMS = new Set(['none', 'uppercase', 'lowercase', 'capitalize']);
const BORDER_STYLES = new Set(['none', 'solid', 'dashed', 'dotted', 'double']);
const GRADIENT_TYPES = new Set(['linear', 'radial']);
const SUBTITLE_POSITIONS = new Set(['bottom', 'top', 'center', 'custom']);
const ANIMATION_TYPES = new Set([
  'fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'scale', 'bounce',
  'flip', 'rotate', 'typewriter',
]);
const ANIMATION_EASINGS = new Set([
  'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out',
  'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
]);
const LINE_BREAK_BEHAVIORS = new Set(['auto', 'manual']);
const CUSTOMIZATION_KEYS = Object.freeze([
  'fontSize', 'fontFamily', 'fontWeight', 'textColor', 'textAlign', 'lineHeight',
  'letterSpacing', 'textTransform', 'backgroundColor', 'backgroundOpacity',
  'backgroundPaddingX', 'backgroundPaddingY', 'borderRadius', 'borderWidth', 'borderColor',
  'borderStyle', 'textShadowEnabled', 'textShadowColor',
  'textShadowBlur', 'textShadowOffsetX', 'textShadowOffsetY', 'glowEnabled', 'glowColor',
  'glowIntensity', 'gradientEnabled', 'gradientType', 'gradientDirection',
  'gradientColorStart', 'gradientColorEnd', 'gradientColorMid', 'strokeEnabled',
  'strokeWidth', 'strokeColor', 'multiShadowEnabled', 'shadowLayers', 'pulseEnabled',
  'pulseSpeed', 'shakeEnabled', 'shakeIntensity', 'position', 'customPositionX',
  'customPositionY', 'marginBottom', 'marginTop', 'marginLeft', 'marginRight', 'maxWidth',
  'fadeInDuration', 'fadeOutDuration', 'animationType', 'animationEasing', 'wordWrap',
  'maxLines', 'lineBreakBehavior', 'rtlSupport', 'preset',
]);
const CUSTOMIZATION_NUMBER_BOUNDS = Object.freeze({
  fontSize: [1, 1_000],
  lineHeight: [0.1, 10],
  letterSpacing: [-100, 1_000],
  backgroundOpacity: [0, 100],
  backgroundPaddingX: [0, 1_000],
  backgroundPaddingY: [0, 1_000],
  borderRadius: [0, 1_000],
  borderWidth: [0, 100],
  textShadowBlur: [0, 1_000],
  textShadowOffsetX: [-2_000, 2_000],
  textShadowOffsetY: [-2_000, 2_000],
  glowIntensity: [0, 1_000],
  strokeWidth: [0, 100],
  pulseSpeed: [0, 100],
  shakeIntensity: [0, 1_000],
  customPositionX: [-1_000, 1_000],
  customPositionY: [-1_000, 1_000],
  marginBottom: [-10_000, 10_000],
  marginTop: [-10_000, 10_000],
  marginLeft: [-10_000, 10_000],
  marginRight: [-10_000, 10_000],
  maxWidth: [1, 1_000],
  fadeInDuration: [0, 60],
  fadeOutDuration: [0, 60],
});
const CUSTOMIZATION_COLOR_KEYS = Object.freeze([
  'textColor', 'backgroundColor', 'borderColor', 'textShadowColor', 'glowColor',
  'gradientColorStart', 'gradientColorEnd', 'gradientColorMid', 'strokeColor',
]);

// One shared descriptor-to-asset conversion, re-raised as a render failure so this module keeps
// its own fixed error surface.
const canonicalAssetFromDescriptor = (descriptor, validationPath = null) => {
  try {
    return sharedCanonicalAssetFromDescriptor(descriptor);
  } catch {
    throw invalidRequest(validationPath);
  }
};

export const normalizeSourceAsset = (asset, { response = false } = {}) => {
  const snapshot = snapshotExactRecord(
    asset,
    ['id', 'displayName', 'extension', 'sizeBytes', 'kind'],
  );
  const extension = typeof snapshot?.extension === 'string'
    ? snapshot.extension.toLowerCase()
    : null;
  const expectedKind = VIDEO_EXTENSIONS.has(extension) ? 'video'
    : AUDIO_EXTENSIONS.has(extension) ? 'audio' : null;
  if (snapshot === null
      || !uuidHasVersion(snapshot.id, 7)
      || typeof snapshot.displayName !== 'string'
      || snapshot.displayName.length === 0
      || snapshot.displayName.trim() !== snapshot.displayName
      || !isWellFormedUtf16(snapshot.displayName)
      || hasControlCharacter(snapshot.displayName)
      || Array.from(snapshot.displayName).length > 512
      || typeof snapshot.extension !== 'string'
      || !/^[A-Za-z0-9]{1,16}$/.test(snapshot.extension)
      || (response && snapshot.extension !== extension)
      || !Number.isSafeInteger(snapshot.sizeBytes)
      || snapshot.sizeBytes <= 0
      || snapshot.kind !== expectedKind) {
    throw invalidRequest();
  }
  return Object.freeze({
    id: snapshot.id,
    displayName: snapshot.displayName,
    extension,
    sizeBytes: snapshot.sizeBytes,
    kind: snapshot.kind,
  });
};

const sameSourceAsset = (left, right) => (
  left.id === right.id
  && left.displayName === right.displayName
  && left.extension === right.extension
  && left.sizeBytes === right.sizeBytes
  && left.kind === right.kind
);

/**
 * Resolve render input from the native media capability, never from a legacy React prop.
 *
 * `selectedVideoFile` still has several browser-era shapes (a File-like object, a playback URL, or a
 * `{ url }` wrapper). None of those proves which durable asset/project is active. The previous code
 * nevertheless required that value to rediscover an asset id, so a valid imported video could play
 * and preview while export refused it as `source.selection`.
 *
 * The active-native-media resolver already intersects the current project revision, durable owner,
 * session pointer, and host playback descriptor. That capability is the authority. A caller value
 * participates only when it carries a native descriptor or the complete canonical asset identity;
 * browser compatibility shapes cannot override (or prevent use of) the selected native asset.
 */
export const createNativeRenderSourceResolver = ({
  resolveActiveMedia = resolveActiveNativeMedia,
  canonicalize = canonicalAssetFromDescriptor,
  isDesktop = isDesktopRuntime,
} = {}) => {
  if (typeof resolveActiveMedia !== 'function'
      || typeof canonicalize !== 'function'
      || typeof isDesktop !== 'function') {
    throw new TypeError('Native render source resolution requires reviewed dependencies');
  }
  return async (value) => {
    if (!isDesktop()) throw runtimeRequired();
    const descriptorCandidate = isNativeMediaDescriptor(value) ? value : null;
    let capability;
    try {
      capability = await resolveActiveMedia({ candidate: descriptorCandidate });
    } catch {
      throw invalidRequest('source.selection');
    }
    const selected = canonicalize(capability?.media, 'source.selectedMedia');
    const asset = validateRequestPart('source.selectedMedia', () => normalizeSourceAsset(selected));
    if (asset.kind !== 'video') throw invalidRequest('source.kind');

    if (isPlainRecord(value)
        && hasExactKeys(value, ['id', 'displayName', 'extension', 'sizeBytes', 'kind'])) {
      const supplied = validateRequestPart('source.asset', () => normalizeSourceAsset(value));
      if (!sameSourceAsset(supplied, asset)) throw invalidRequest('source.identity');
    }
    return asset;
  };
};

export const resolveNativeRenderSource = createNativeRenderSourceResolver();

/**
 * The project a render binds to is the one that owns the active media, read through the
 * active-workspace pointer and resolved without creating anything. Media the pointer does not name
 * is refused: an asset (a quality re-download, say) is always published through its owner first,
 * so resolving it by asset ID here would mint a second project or attach it to the wrong one.
 */
export const ensureNativeRenderProject = async (sourceAsset) => {
  if (!isDesktopRuntime()) throw runtimeRequired();
  const asset = validateRequestPart('project.source', () => normalizeSourceAsset(sourceAsset));
  const session = readNativeMediaSession();
  if (session?.assetId !== asset.id) throw invalidRequest('project.ownership');
  const owned = await resolveOwnedNativeMediaProject(session);
  if (owned === null) throw invalidRequest('project.ownership');
  const existing = owned.snapshot.media.find((candidate) => candidate.id === asset.id);
  if (!existing || !sameSourceAsset(existing, asset)) {
    throw invalidRequest('project.sourceIdentity');
  }
  return owned.projectId;
};

const normalizeLyrics = (lyrics) => {
  if (!Array.isArray(lyrics) || lyrics.length === 0 || lyrics.length > MAX_RENDER_LYRICS) {
    throw invalidRequest();
  }
  const ids = new Set();
  let totalTextBytes = 0;
  return Object.freeze(lyrics.map((lyric, index) => {
    const snapshot = snapshotPlainRecord(lyric);
    if (snapshot === null) throw invalidRequest();
    const rawId = snapshot.id ?? snapshot.subtitle_id ?? index;
    const id = `cue-${index}-${String(rawId)}`;
    if (!isWellFormedUtf16(id) || hasControlCharacter(id)
        || utf8ByteLength(id) > 128 || ids.has(id)) {
      throw invalidRequest();
    }
    ids.add(id);
    const startUs = secondsToMicros(snapshot.start ?? snapshot.start_time ?? snapshot.startTime);
    const endUs = secondsToMicros(snapshot.end ?? snapshot.end_time ?? snapshot.endTime);
    const text = requireString(subtitleDisplayText({ ...snapshot, text: String(snapshot.text ?? '') }), 16 * 1024, {
      allowTextWhitespace: true,
    });
    totalTextBytes += utf8ByteLength(text);
    if (totalTextBytes > MAX_TOTAL_LYRIC_BYTES) throw invalidRequest();
    if (startUs >= endUs) throw invalidRequest();
    return Object.freeze({ id, startUs, endUs, text });
  }));
};

const normalizeSettings = (settings) => {
  const snapshot = snapshotPlainRecord(settings);
  if (snapshot === null) throw invalidRequest();
  const trimStartUs = secondsToMicros(snapshot.trimStart ?? 0);
  const rawTrimEnd = Number(snapshot.trimEnd ?? 0);
  if (!Number.isFinite(rawTrimEnd) || rawTrimEnd < 0) throw invalidRequest();
  const trimEndUs = rawTrimEnd === 0 ? null : secondsToMicros(rawTrimEnd);
  if (trimEndUs !== null && trimEndUs <= trimStartUs) throw invalidRequest();
  return Object.freeze({
    resolution: requireEnum(snapshot.resolution, RESOLUTIONS),
    frameRate: requireEnum(Number(snapshot.frameRate), FRAME_RATES),
    originalAudioVolume: requireInteger(Number(snapshot.originalAudioVolume), 0, 100),
    narrationVolume: requireInteger(Number(snapshot.narrationVolume), 0, 100),
    trimStartUs,
    trimEndUs,
  });
};

const normalizeCustomization = (customization) => {
  const snapshot = snapshotExactRecord(customization, CUSTOMIZATION_KEYS);
  if (snapshot === null) throw invalidRequest();
  const normalized = { ...snapshot };
  Object.entries(CUSTOMIZATION_NUMBER_BOUNDS).forEach(([key, [minimum, maximum]]) => {
    requireFinite(normalized[key], minimum, maximum);
  });
  requireInteger(normalized.fontWeight, 100, 900);
  if (normalized.fontWeight % 100 !== 0) throw invalidRequest();
  requireInteger(normalized.shadowLayers, 0, 16);
  requireInteger(normalized.maxLines, 1, 32);
  [
    'textShadowEnabled', 'glowEnabled', 'gradientEnabled', 'strokeEnabled',
    'multiShadowEnabled', 'pulseEnabled', 'shakeEnabled', 'wordWrap', 'rtlSupport',
  ].forEach((key) => requireBoolean(normalized[key]));
  requireString(normalized.fontFamily, 256);
  requireString(normalized.preset, 128);
  CUSTOMIZATION_COLOR_KEYS.forEach((key) => requireColor(normalized[key]));
  requireGradientDirection(normalized.gradientDirection);
  requireEnum(normalized.textAlign, TEXT_ALIGNMENTS);
  requireEnum(normalized.textTransform, TEXT_TRANSFORMS);
  requireEnum(normalized.borderStyle, BORDER_STYLES);
  requireEnum(normalized.gradientType, GRADIENT_TYPES);
  requireEnum(normalized.position, SUBTITLE_POSITIONS);
  requireEnum(normalized.animationType, ANIMATION_TYPES);
  requireEnum(normalized.animationEasing, ANIMATION_EASINGS);
  requireEnum(normalized.lineBreakBehavior, LINE_BREAK_BEHAVIORS);
  return Object.freeze(normalized);
};

const normalizeCrop = (crop) => {
  const snapshot = snapshotPlainRecord(crop);
  if (snapshot === null) throw invalidRequest();
  const aspectRatio = snapshot.aspectRatio ?? null;
  if (aspectRatio !== null) requireFinite(aspectRatio, 0.01, 100);
  const canvasBgMode = snapshot.canvasBgMode ?? 'solid';
  if (!['solid', 'blur'].includes(canvasBgMode)) throw invalidRequest();
  const canvasBgColor = snapshot.canvasBgColor ?? '#000000';
  const canvasBgBlur = snapshot.canvasBgBlur ?? 24;
  const flipX = snapshot.flipX ?? false;
  const flipY = snapshot.flipY ?? false;
  requireColor(canvasBgColor);
  requireBoolean(flipX);
  requireBoolean(flipY);
  return Object.freeze({
    x: requireFinite(snapshot.x ?? 0, -1_000, 1_000),
    y: requireFinite(snapshot.y ?? 0, -1_000, 1_000),
    width: requireFinite(snapshot.width ?? 100, 0.01, 1_000),
    height: requireFinite(snapshot.height ?? 100, 0.01, 1_000),
    aspectRatio,
    canvasBgMode,
    canvasBgColor,
    canvasBgBlur: requireFinite(canvasBgBlur, 0, 1_000),
    flipX,
    flipY,
  });
};

// Project render-scene persistence deliberately reuses these exact normalizers. Exporting the
// already-owned contract is narrower than maintaining a second settings/style/crop vocabulary in
// the persistence bridge (the legacy implementation did exactly that and let preview and export
// disagree).
export const normalizeNativeRenderSettings = normalizeSettings;
export const normalizeNativeSubtitleCustomization = normalizeCustomization;
export const normalizeNativeRenderCrop = normalizeCrop;

export const buildNativeRenderRequest = ({
  sourceAsset,
  projectId,
  sceneRevision = 0,
  narrationArtifactId = null,
  selectedSubtitles = 'original',
  selectedNarration = narrationArtifactId === null ? 'none' : 'generated',
  lyrics,
  settings,
  customization,
  crop,
}) => {
  const source = validateRequestPart('source', () => normalizeSourceAsset(sourceAsset));
  if (source.kind !== 'video') throw invalidRequest('source.kind');
  const normalizedNarrationArtifactId = narrationArtifactId === null
    ? null
    : validateRequestPart('narrationArtifactId', () => requireUuid(narrationArtifactId, 7));
  if (!SUBTITLE_SOURCES.has(selectedSubtitles)
      || !NARRATION_SOURCES.has(selectedNarration)
      || (selectedNarration === 'generated') !== (normalizedNarrationArtifactId !== null)) {
    throw invalidRequest('selection');
  }
  return Object.freeze({
    sourceAssetId: source.id,
    projectId: validateRequestPart('projectId', () => requireUuid(projectId, 7)),
    sceneRevision: validateRequestPart(
      'sceneRevision',
      () => requireInteger(sceneRevision, 0, Number.MAX_SAFE_INTEGER),
    ),
    selectedSubtitles,
    selectedNarration,
    narrationArtifactId: normalizedNarrationArtifactId,
    lyrics: validateRequestPart('lyrics', () => normalizeLyrics(lyrics)),
    settings: validateRequestPart('settings', () => normalizeSettings(settings)),
    customization: validateRequestPart(
      'customization',
      () => normalizeCustomization(customization),
    ),
    crop: validateRequestPart('crop', () => normalizeCrop(crop)),
  });
};
