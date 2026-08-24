import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { resolveActiveNativeMedia } from './activeNativeMedia';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import { isNativeMediaDescriptor, isNativeMediaPlaybackUrl } from './mediaService';
import {
  canonicalAssetFromDescriptor as sharedCanonicalAssetFromDescriptor,
  readNativeMediaSession,
  resolveOwnedNativeMediaProject,
} from './nativeMediaOwnership';
import { mutateProject } from './projectService';
import { resolveProjectForCache } from './subtitleProjectStore';

export const MAX_RENDER_LYRICS = 100_000;

/** Mirrors `EXPORT_TEXT_SCHEMA_VERSION` in `apps/desktop/src-tauri/src/render/text.rs`. */
const EXPORT_TEXT_SCHEMA_VERSION = 2;
const EXPORT_TEXT_KEYS = Object.freeze([
  'schemaVersion', 'face', 'pages', 'cues',
]);
const EXPORT_PAGE_KEYS = Object.freeze(['atlasId', 'atlasContentHash']);
const EXPORT_CUE_RUN_KEYS = Object.freeze(['page', 'lines']);
const EXPORT_CUE_LINE_KEYS = Object.freeze([
  'glyphs', 'penXPx', 'advanceWidthPx', 'baselineYPx',
]);
/** Mirrors `MAX_ATLAS_PAGES` in `crates/osg-scene/src/glyph/limits.rs`. */
const MAX_EXPORT_PAGES = 32;
const EXPORT_FACE_KEYS = Object.freeze(['family', 'source', 'weight']);
/** Mirrors `MAX_IDENTITY_BYTES` and `is_opaque_identity` in the same file. */
const OPAQUE_IDENTITY_PATTERN = /^[A-Za-z0-9\-_:]{1,128}$/;
/** Mirrors `MAX_RUN_LINES` and `MAX_RUN_GLYPHS` in `crates/osg-compositor/src/run.rs`. */
const MAX_EXPORT_RUN_LINES = 64;
const MAX_EXPORT_RUN_CELLS = 4_096;

const MAX_RENDER_DURATION_MICROS = 24 * 60 * 60 * 1_000_000;
const MAX_TOTAL_LYRIC_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_EVENTS = 4_096;
const MAX_POLL_MS = 24 * 60 * 60 * 1_000;
const JOB_STATES = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const ACTIVE_JOB_STATES = new Set(['queued', 'running', 'cancelling']);
const CANCELLATION_RESPONSE_STATES = new Set([
  'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const RENDER_UNAVAILABLE_REASONS = new Set([
  'runtimePayloadUnavailable', 'mediaToolsUnavailable',
]);
const RENDER_COMMAND_CODES = new Set([
  'internal',
  'invalidInput',
  'invalidRenderRequest',
  'mediaUnavailable',
  'invalidMediaLocation',
  'mediaIdentityConflict',
  'mediaToolsUnavailable',
  'renderRuntimeUnavailable',
  'renderBusy',
  'renderPublicationFailed',
  'renderSourceChanged',
  'renderNarrationChanged',
  // The refusals the staged-text boundary added. `apps/desktop/src-tauri/src/render/refusal.rs`
  // raises each of these for a distinct thing a user can act on differently, so they keep their own
  // sentences rather than collapsing into the categorical native failure.
  'renderTextNotStaged',
  'renderAtlasUnknown',
  'renderTextMismatched',
  'renderTextPagesMissing',
  'renderTextTooManyPages',
  'renderTextPageUnknown',
  'renderFontUnavailable',
  'renderSourceUnreadable',
  'renderSourceTruncated',
  'renderAudioUnusable',
  'renderVolumeFull',
  'renderDeviceLost',
  'renderSceneRejected',
  'renderAtlasCannotLayOut',
  'renderStagingUnavailable',
  'renderMediaPreparationFailed',
  'renderWorkerProtocol',
  'renderWorkerFailed',
  'renderCancelled',
  'renderTimeout',
  'renderOutputInvalid',
  'renderIo',
  'mediaRegistryFull',
  'mediaServer',
  'jobAlreadyExists',
  'jobNotFound',
  'jobConflict',
  'invalidJob',
  'invalidJobState',
  'jobSequenceLimit',
  'jobRegistry',
  'database',
  'artifactStorage',
  'artifactDataCorrupt',
  'invalidArtifactRequest',
  'artifactMetadataTooLarge',
  'artifactLimit',
  'artifactNotFound',
  'artifactContentMismatch',
  'artifactConflict',
  'artifactStateConflict',
  'artifactNotReady',
  'projectNotFound',
  'staleProjectVersion',
  'staleProjectRenderScene',
  'invalidProject',
  'projectTooLarge',
  'projectDataCorrupt',
]);
const RENDER_PHASES = new Set([
  'staging', 'extractingFrames', 'extractingAudio', 'loadingComposition',
  'renderingFrames', 'encoding', 'muxing', 'publishing',
]);
const RENDER_PHASE_ORDER = new Map([
  'staging', 'extractingFrames', 'extractingAudio', 'loadingComposition',
  'renderingFrames', 'encoding', 'muxing', 'publishing',
].map((phase, index) => [phase, index]));
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
  'letterSpacing', 'textTransform', 'backgroundColor', 'backgroundOpacity', 'borderRadius',
  'borderWidth', 'borderColor', 'borderStyle', 'textShadowEnabled', 'textShadowColor',
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

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const snapshotPlainRecord = (value) => {
  try {
    if (!isRecord(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null
        || Object.getOwnPropertySymbols(value).length !== 0) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || !('value' in descriptor)
    )) {
      return null;
    }
    return Object.freeze(Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
    ));
  } catch {
    return null;
  }
};

const isPlainRecord = (value) => snapshotPlainRecord(value) !== null;

const snapshotExactRecord = (value, keys) => {
  const snapshot = snapshotPlainRecord(value);
  if (snapshot === null || Object.keys(snapshot).length !== keys.length
      || !keys.every((key) => Object.prototype.hasOwnProperty.call(snapshot, key))) {
    return null;
  }
  return snapshot;
};

const hasExactKeys = (value, keys) => (
  snapshotExactRecord(value, keys) !== null
);

const hasOnlyKeys = (value, keys) => (
  isPlainRecord(value) && Object.keys(value).every((key) => keys.has(key))
);

const uuidHasVersion = (value, expectedVersion) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === expectedVersion;
  } catch {
    return false;
  }
};

export class NativeRenderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeRenderError';
    this.code = code;
  }
}

const invalidRequest = (validationPath = null) => {
  const error = new NativeRenderError(
    'invalidRenderRequest',
    'The native video render request is invalid',
  );
  if (typeof validationPath === 'string' && validationPath.length > 0) {
    error.validationPath = validationPath;
  }
  return error;
};

const validateRequestPart = (validationPath, validator) => {
  try {
    return validator();
  } catch (error) {
    if (error instanceof NativeRenderError && error.code === 'invalidRenderRequest') {
      throw invalidRequest(error.validationPath ?? validationPath);
    }
    throw error;
  }
};

const invalidResponse = () => new NativeRenderError(
  'invalidRenderResponse',
  'The desktop host returned invalid native render data'
);

const runtimeRequired = () => new NativeRenderError(
  'desktopRenderRequired',
  'Native video rendering requires the desktop runtime'
);

const cancelled = () => {
  const error = new NativeRenderError('renderCancelled', 'The native video render was cancelled');
  error.name = 'AbortError';
  return error;
};

const internalAbortMonitors = new WeakMap();

const createAbortMonitor = (signal) => {
  if (signal === null) return null;
  let initiallyAborted;
  let addEventListener;
  let removeEventListener;
  try {
    if (!isRecord(signal)) throw invalidRequest();
    initiallyAborted = signal.aborted;
    addEventListener = signal.addEventListener;
    removeEventListener = signal.removeEventListener;
  } catch {
    throw invalidRequest();
  }
  if (typeof initiallyAborted !== 'boolean'
      || typeof addEventListener !== 'function'
      || typeof removeEventListener !== 'function') {
    throw invalidRequest();
  }

  let aborted = initiallyAborted;
  let attached = false;
  let disposed = false;
  const listeners = new Set();
  const notify = () => {
    if (disposed || aborted) return;
    aborted = true;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // An internal cancellation observer cannot break the other owners.
      }
    }
  };
  const detachUpstream = () => {
    if (!attached) return;
    attached = false;
    try {
      removeEventListener.call(signal, 'abort', notify);
    } catch {
      // A hostile cleanup method cannot escape into terminal delivery.
    }
  };

  if (!aborted) {
    let registrationFailed = false;
    try {
      addEventListener.call(signal, 'abort', notify, { once: true });
      attached = true;
    } catch {
      registrationFailed = true;
      // The method may have attached before throwing, so attempt guarded cleanup.
      attached = true;
      detachUpstream();
      if (!aborted) {
        disposed = true;
        throw invalidRequest();
      }
    }
    if (!registrationFailed) {
      let observedAfterRegistration;
      try {
        observedAfterRegistration = signal.aborted;
      } catch {
        detachUpstream();
        disposed = true;
        throw invalidRequest();
      }
      if (typeof observedAfterRegistration !== 'boolean') {
        detachUpstream();
        disposed = true;
        throw invalidRequest();
      }
      if (observedAfterRegistration) notify();
    }
  }

  return Object.freeze({
    isAborted: () => aborted,
    listen: (listener) => {
      if (typeof listener !== 'function') throw invalidRequest();
      if (aborted) {
        try {
          listener();
        } catch {
          // Cancellation remains authoritative.
        }
        return () => {};
      }
      if (disposed) return () => {};
      listeners.add(listener);
      let listening = true;
      return () => {
        if (!listening) return;
        listening = false;
        listeners.delete(listener);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      detachUpstream();
    },
  });
};

const dataProperty = (value, key) => {
  try {
    if (!isRecord(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value')
      ? Object.freeze({ value: descriptor.value })
      : null;
  } catch {
    return null;
  }
};

/**
 * What a user is told a native render failed for.
 *
 * A lookup rather than the nested conditional this was, because the vocabulary grew: the staged-text
 * boundary added five refusals a user acts on differently, and a twenty-deep ternary is not a place
 * to add anything. A code with no entry falls through to the categorical sentence, which is what
 * every code this build has not been taught still gets.
 *
 * `renderRuntimeUnavailable` no longer names an installable renderer, because that sentence is no
 * longer true: `render_runtime_status` reports whether this BUILD has the native pipeline
 * (`cfg!(windows)`), not whether a payload is installed, and nothing in Settings can change the
 * answer. The code is also no longer reachable from a render: `render_start` cannot raise it, and
 * the only thing that does is the frontend's own readiness check.
 */
const RENDER_FAILURE_MESSAGES = new Map([
  ['renderRuntimeUnavailable', 'This build cannot render video on this computer'],
  ['mediaToolsUnavailable', 'Install FFmpeg and FFprobe in Settings before rendering'],
  ['renderBusy', 'Another video render is already running'],
  ['invalidRenderRequest', 'The selected video, subtitles, or render settings are invalid'],
  ['invalidInput', 'The selected video, subtitles, or render settings are invalid'],
  ['mediaUnavailable', 'The selected video is no longer available'],
  ['invalidMediaLocation', 'The selected video is no longer available'],
  ['mediaIdentityConflict', 'The selected video is no longer available'],
  ['renderSourceChanged', 'The source video changed before rendering completed'],
  ['renderNarrationChanged', 'The narration audio changed before rendering completed'],
  ['renderPublicationFailed', 'The rendered video could not be saved durably'],
  ['renderCancelled', 'The native video render was cancelled'],
  ['renderTimeout', 'The native video render exceeded its safe time limit'],
  ['renderTextNotStaged', 'The subtitles for this render were not prepared for the renderer'],
  ['renderAtlasUnknown', 'The prepared subtitles for this render expired. Try again'],
  ['renderTextMismatched', 'The prepared subtitles do not match the subtitles being rendered'],
  ['renderTextPagesMissing', 'The subtitles for this render were prepared without any glyphs to draw'],
  // The one refusal in this list that is a product limit rather than a malformed payload, so it is
  // the one whose message has to tell the user what to do about it.
  ['renderTextTooManyPages', 'These subtitles use more distinct characters than one render can hold. Split them into shorter renders'],
  ['renderTextPageUnknown', 'A subtitle in this render points at glyphs that were not prepared with it'],
  ['renderFontUnavailable', 'The font this render asks for is not the font the subtitles were measured with'],
  ['renderAtlasCannotLayOut', 'These subtitles are shaped in a way this render cannot place'],
  ['renderSourceUnreadable', 'The source video format could not be decoded by this computer'],
  ['renderSourceTruncated', 'The source video ended before its declared duration'],
  ['renderAudioUnusable', 'The audio for this render could not be decoded and mixed'],
  ['renderVolumeFull', 'There is not enough free space to write the rendered video'],
  ['renderDeviceLost', 'No usable graphics device is available to render this video'],
  ['renderSceneRejected', 'This render is not one the native renderer can draw'],
  ['renderStagingUnavailable', 'The renderer has nowhere to write its working files'],
  ['renderOutputInvalid', 'The render did not produce the video the timeline describes'],
  ['renderIo', 'The rendered video could not be written to disk'],
]);

/**
 * Exported for the contract guard in `renderService.test.js`, which reads the code vocabulary out of
 * `apps/desktop/src-tauri/src/render/refusal.rs` and requires every code Rust mints to survive the
 * transport and to say something specific. Nothing else calls either of these from outside.
 */
export const renderFailureMessage = (code) => (
  RENDER_FAILURE_MESSAGES.get(code) ?? 'The native video render could not be completed'
);

export const allowedRenderCode = (value, fallback = 'nativeRenderFailed') => {
  try {
    const candidate = value?.code;
    return RENDER_COMMAND_CODES.has(candidate) ? candidate : fallback;
  } catch {
    return fallback;
  }
};

const normalizeFailure = (value) => {
  try {
    if (value instanceof NativeRenderError) return value;
  } catch {
    // Hostile transport proxies are never authoritative error metadata.
  }
  const code = allowedRenderCode(value);
  return new NativeRenderError(code, renderFailureMessage(code));
};

const requireInteger = (value, minimum, maximum, response = false) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw response ? invalidResponse() : invalidRequest();
  }
  return value;
};

const requireFinite = (value, minimum, maximum) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidRequest();
  }
  return value;
};

const requireUuid = (value, expectedVersion, response = false) => {
  if (!uuidHasVersion(value, expectedVersion)) {
    throw response ? invalidResponse() : invalidRequest();
  }
  return value;
};

const requireEnum = (value, allowed) => {
  if (!allowed.has(value)) throw invalidRequest();
  return value;
};

const isWellFormedUtf16 = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      if (index + 1 >= value.length) return false;
      const following = value.charCodeAt(index + 1);
      if (following < 0xDC00 || following > 0xDFFF) return false;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false;
    }
  }
  return true;
};

const hasControlCharacter = (value, allowTextWhitespace = false) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const isControl = codeUnit <= 0x1F || (codeUnit >= 0x7F && codeUnit <= 0x9F);
    if (isControl && !(allowTextWhitespace && [0x09, 0x0A, 0x0D].includes(codeUnit))) {
      return true;
    }
  }
  return false;
};

const utf8ByteLength = (value) => new TextEncoder().encode(value).byteLength;

const requireString = (value, maximumBytes = 16_384, options = {}) => {
  const { allowTextWhitespace = false } = options;
  if (typeof value !== 'string' || value.length === 0 || !isWellFormedUtf16(value)
      || hasControlCharacter(value, allowTextWhitespace)
      || utf8ByteLength(value) > maximumBytes) {
    throw invalidRequest();
  }
  return value;
};

const requireColor = (value) => {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]+$/.test(value)
      || ![4, 5, 7, 9].includes(value.length)) {
    throw invalidRequest();
  }
  return value;
};

const requireGradientDirection = (value) => {
  if (typeof value !== 'string' || !/^\d+deg$/.test(value)) throw invalidRequest();
  const degrees = Number(value.slice(0, -3));
  if (!Number.isSafeInteger(degrees) || degrees > 360) throw invalidRequest();
  return value;
};

const requireBoolean = (value) => {
  if (typeof value !== 'boolean') throw invalidRequest();
  return value;
};

const secondsToMicros = (value) => {
  const seconds = requireFinite(Number(value), 0, MAX_RENDER_DURATION_MICROS / 1_000_000);
  return requireInteger(Math.round(seconds * 1_000_000), 0, MAX_RENDER_DURATION_MICROS);
};

// One shared descriptor-to-asset conversion, re-raised as a render failure so this module keeps
// its own fixed error surface.
const canonicalAssetFromDescriptor = (descriptor, validationPath = null) => {
  try {
    return sharedCanonicalAssetFromDescriptor(descriptor);
  } catch {
    throw invalidRequest(validationPath);
  }
};

const normalizeSourceAsset = (asset, { response = false } = {}) => {
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

export const ensureNativeRenderProject = async (sourceAsset) => {
  if (!isDesktopRuntime()) throw runtimeRequired();
  const asset = validateRequestPart('project.source', () => normalizeSourceAsset(sourceAsset));
  const session = readNativeMediaSession();
  if (session?.assetId === asset.id) {
    const owned = await resolveOwnedNativeMediaProject(session);
    if (owned === null) throw invalidRequest('project.ownership');
    const existing = owned.snapshot.media.find((candidate) => candidate.id === asset.id);
    if (!existing
        || existing.displayName !== asset.displayName
        || existing.extension !== asset.extension
        || existing.sizeBytes !== asset.sizeBytes
        || existing.kind !== asset.kind) {
      throw invalidRequest('project.sourceIdentity');
    }
    return owned.projectId;
  }
  const resolved = await resolveProjectForCache(asset.id, { create: true });
  if (!resolved || !uuidHasVersion(resolved.projectId, 7) || !isPlainRecord(resolved.snapshot)) {
    throw invalidRequest('project.resolution');
  }
  const existing = resolved.snapshot.media.find((candidate) => candidate.id === asset.id);
  if (existing) {
    if (existing.displayName !== asset.displayName
        || existing.extension !== asset.extension
        || existing.sizeBytes !== asset.sizeBytes
        || existing.kind !== asset.kind) {
      throw invalidRequest('project.sourceIdentity');
    }
    return resolved.projectId;
  }
  const committed = await mutateProject(
    resolved.projectId,
    'Associate source media for native render',
    (snapshot) => ({ ...snapshot, media: [...snapshot.media, asset] }),
    { retryOnConflict: true }
  );
  if (!committed?.snapshot?.media?.some((candidate) => candidate.id === asset.id)) {
    throw invalidResponse();
  }
  return resolved.projectId;
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
    const text = requireString(String(snapshot.text ?? ''), 16 * 1024, {
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

/**
 * The staged text `render_start` draws with, checked for what belongs to THIS boundary.
 *
 * The architecture forbids a Rust text stack, so an export's glyphs arrive already shaped: the
 * staged atlas pages, and one laid-out run per cue — carrying its page — in the request's own cue
 * order.
 * `src/components/previews/native/exportTextStaging.js` produces it and
 * `apps/desktop/src-tauri/src/render/text.rs` deserialises it.
 *
 * Deliberately a SHAPE check and not a second opinion about layout. Whether the runs agree with the
 * atlas is decided by `osg_compositor::SubtitleScene`, which is the code that defines what a
 * drawable run is; restating any of it here would be a third vocabulary to keep in step. What is
 * checked is what this boundary owns: the payload version, the opacity of the identity it carries,
 * that it describes THESE cues, and the sizes it would otherwise make the far side allocate.
 *
 * The payload is copied field by field rather than forwarded, so nothing a caller mutates after
 * this returns can reach the command.
 */
const normalizeExportCueLine = (line) => {
  const snapshot = snapshotExactRecord(line, EXPORT_CUE_LINE_KEYS);
  if (snapshot === null
      || !Array.isArray(snapshot.glyphs)
      || !Array.isArray(snapshot.penXPx)
      || snapshot.glyphs.length !== snapshot.penXPx.length) {
    throw invalidRequest();
  }
  const glyphs = snapshot.glyphs.map((cell) => requireInteger(cell, 0, 0xffff_ffff));
  const penXPx = snapshot.penXPx.map((pen) => requireFinite(pen, -1e12, 1e12));
  return Object.freeze({
    glyphs: Object.freeze(glyphs),
    penXPx: Object.freeze(penXPx),
    advanceWidthPx: requireFinite(snapshot.advanceWidthPx, -1e12, 1e12),
    baselineYPx: requireFinite(snapshot.baselineYPx, -1e12, 1e12),
  });
};

const normalizeExportCueRun = (run, pageCount) => {
  const snapshot = snapshotExactRecord(run, EXPORT_CUE_RUN_KEYS);
  if (snapshot === null
      || !Array.isArray(snapshot.lines)
      || snapshot.lines.length === 0
      || snapshot.lines.length > MAX_EXPORT_RUN_LINES) {
    throw invalidRequest();
  }
  // A cue names the page its cells index. Whether the indices fit that page's table is
  // `osg_compositor::SubtitleScene`'s question; whether the page exists at all is this one's.
  const page = requireInteger(snapshot.page, 0, pageCount - 1);
  const lines = snapshot.lines.map(normalizeExportCueLine);
  const cells = lines.reduce((total, line) => total + line.glyphs.length, 0);
  if (cells > MAX_EXPORT_RUN_CELLS) throw invalidRequest();
  return Object.freeze({ page, lines: Object.freeze(lines) });
};

const normalizeExportPage = (page) => {
  const snapshot = snapshotExactRecord(page, EXPORT_PAGE_KEYS);
  if (snapshot === null
      || !uuidHasVersion(snapshot.atlasId, 7)
      || typeof snapshot.atlasContentHash !== 'string'
      || !OPAQUE_IDENTITY_PATTERN.test(snapshot.atlasContentHash)) {
    throw invalidRequest();
  }
  return Object.freeze({
    atlasId: snapshot.atlasId,
    atlasContentHash: snapshot.atlasContentHash,
  });
};

export const normalizeExportText = (text, request) => {
  const snapshot = snapshotExactRecord(text, EXPORT_TEXT_KEYS);
  const face = snapshot === null ? null : snapshotExactRecord(snapshot.face, EXPORT_FACE_KEYS);
  if (snapshot === null || face === null
      || snapshot.schemaVersion !== EXPORT_TEXT_SCHEMA_VERSION
      || !Array.isArray(snapshot.pages)
      || snapshot.pages.length === 0
      || snapshot.pages.length > MAX_EXPORT_PAGES
      || !Array.isArray(snapshot.cues)
      || !Array.isArray(request?.lyrics)
      || snapshot.cues.length !== request.lyrics.length) {
    throw invalidRequest();
  }
  // A face that never resolved is the failure this pipeline exists to stop hiding, so the payload
  // may not carry a weight or a byte source the renderer would have to guess at.
  requireString(face.family, 256);
  requireString(face.source, 256);
  requireInteger(face.weight, 100, 900);
  if (face.weight % 100 !== 0) throw invalidRequest();
  const pages = snapshot.pages.map(normalizeExportPage);
  return Object.freeze({
    schemaVersion: EXPORT_TEXT_SCHEMA_VERSION,
    face: Object.freeze({ family: face.family, source: face.source, weight: face.weight }),
    pages: Object.freeze(pages),
    cues: Object.freeze(snapshot.cues.map((run) => normalizeExportCueRun(run, pages.length))),
  });
};

export const normalizeRenderJob = (job) => {
  const snapshot = snapshotExactRecord(job, ['id', 'kind', 'state', 'progress', 'sequence']);
  const progressSnapshot = snapshot === null
    ? null
    : snapshotExactRecord(snapshot.progress, ['basisPoints']);
  if (snapshot === null || progressSnapshot === null
      || !uuidHasVersion(snapshot.id, 7)
      || snapshot.kind !== 'renderVideo'
      || !JOB_STATES.has(snapshot.state)) {
    throw invalidResponse();
  }
  const progress = requireInteger(progressSnapshot.basisPoints, 0, 10_000, true);
  const sequence = requireInteger(snapshot.sequence, 0, Number.MAX_SAFE_INTEGER, true);
  if ((snapshot.state === 'queued' && (progress !== 0 || sequence !== 0))
      || (snapshot.state === 'succeeded' && progress !== 10_000)
      || (!['queued', 'succeeded'].includes(snapshot.state) && sequence < 1)) {
    throw invalidResponse();
  }
  return Object.freeze({
    id: snapshot.id,
    kind: 'renderVideo',
    state: snapshot.state,
    progress: Object.freeze({ basisPoints: progress }),
    sequence,
  });
};

const normalizeMediaAsset = (asset) => {
  try {
    return normalizeSourceAsset(asset, { response: true });
  } catch {
    throw invalidResponse();
  }
};

const normalizePlayback = (playback, asset) => {
  const snapshot = snapshotExactRecord(
    playback,
    ['id', 'playbackUrl', 'mimeType', 'byteLength'],
  );
  if (snapshot === null
      || !uuidHasVersion(snapshot.id, 4)
      || !isNativeMediaPlaybackUrl(snapshot.playbackUrl, snapshot.id)
      || snapshot.mimeType !== 'video/mp4'
      || snapshot.byteLength !== asset.sizeBytes) {
    throw invalidResponse();
  }
  return snapshot;
};

const extractPlaybackCapability = (value) => {
  try {
    const resultPlayback = dataProperty(value, 'playback');
    const playback = snapshotExactRecord(
      resultPlayback?.value,
      ['id', 'playbackUrl', 'mimeType', 'byteLength'],
    );
    if (playback === null || !uuidHasVersion(playback.id, 4)
        || !isNativeMediaPlaybackUrl(playback.playbackUrl, playback.id)
        || playback.mimeType !== 'video/mp4'
        || !Number.isSafeInteger(playback.byteLength)
        || playback.byteLength <= 0) {
      return null;
    }
    return playback.id;
  } catch {
    return null;
  }
};

const extractPlaybackOwnership = (value, expectedEvent = null) => {
  try {
    const eventName = dataProperty(value, 'event');
    if (expectedEvent !== null && eventName?.value !== expectedEvent) {
      return null;
    }
    const result = dataProperty(value, 'result');
    const playbackId = extractPlaybackCapability(result?.value);
    if (playbackId === null) return null;
    const jobValue = dataProperty(value, 'job');
    const job = snapshotPlainRecord(jobValue?.value);
    const jobId = job !== null && uuidHasVersion(job.id, 7) ? job.id : null;
    return Object.freeze({ jobId, playbackId });
  } catch {
    return null;
  }
};

const extractCompletedPlaybackOwnership = (value) => (
  extractPlaybackOwnership(value, 'completed')
);

export const normalizeRenderResult = (result) => {
  const snapshot = snapshotExactRecord(result, [
    'artifactId', 'asset', 'sourceAssetId', 'projectId', 'width', 'height', 'fps',
    'durationInFrames', 'playback',
  ]);
  if (snapshot === null) throw invalidResponse();
  const asset = normalizeMediaAsset(snapshot.asset);
  if (asset.kind !== 'video' || asset.extension !== 'mp4') throw invalidResponse();
  return Object.freeze({
    artifactId: requireUuid(snapshot.artifactId, 7, true),
    asset,
    sourceAssetId: requireUuid(snapshot.sourceAssetId, 7, true),
    projectId: requireUuid(snapshot.projectId, 7, true),
    width: requireInteger(snapshot.width, 2, 15_360, true),
    height: requireInteger(snapshot.height, 2, 8_640, true),
    fps: requireInteger(snapshot.fps, 1, 120, true),
    durationInFrames: requireInteger(snapshot.durationInFrames, 1, 1_000_000, true),
    playback: normalizePlayback(snapshot.playback, asset),
  });
};

export const normalizeRenderResultResponse = (value) => {
  const snapshot = snapshotExactRecord(value, ['job', 'result']);
  if (snapshot === null) throw invalidResponse();
  const job = normalizeRenderJob(snapshot.job);
  const result = snapshot.result === null ? null : normalizeRenderResult(snapshot.result);
  if (job.state === 'succeeded' ? result === null : result !== null) throw invalidResponse();
  return Object.freeze({ job, result });
};

const normalizeCommandError = (value) => {
  const snapshot = snapshotExactRecord(value, ['code', 'message']);
  if (snapshot === null || typeof snapshot.code !== 'string'
      || typeof snapshot.message !== 'string') {
    throw invalidResponse();
  }
  const code = RENDER_COMMAND_CODES.has(snapshot.code) ? snapshot.code : 'nativeRenderFailed';
  return Object.freeze({ code, message: renderFailureMessage(code) });
};

export const normalizeRenderEvent = (value) => {
  const eventSnapshot = snapshotPlainRecord(value);
  const eventName = eventSnapshot?.event;
  if (typeof eventName !== 'string') throw invalidResponse();
  if (eventName === 'progress') {
    const snapshot = snapshotExactRecord(eventSnapshot, [
      'event', 'job', 'phase', 'fractionMillionths', 'renderedFrames', 'encodedFrames',
      'durationInFrames',
    ]);
    if (snapshot === null || !RENDER_PHASES.has(snapshot.phase)) {
      throw invalidResponse();
    }
    const job = normalizeRenderJob(snapshot.job);
    if (job.state !== 'running') throw invalidResponse();
    const durationInFrames = requireInteger(snapshot.durationInFrames, 1, 1_000_000, true);
    return Object.freeze({
      event: 'progress',
      job,
      phase: snapshot.phase,
      fractionMillionths: requireInteger(snapshot.fractionMillionths, 0, 1_000_000, true),
      renderedFrames: requireInteger(snapshot.renderedFrames, 0, durationInFrames, true),
      encodedFrames: requireInteger(snapshot.encodedFrames, 0, durationInFrames, true),
      durationInFrames,
    });
  }
  if (eventName === 'completed') {
    const snapshot = snapshotExactRecord(eventSnapshot, ['event', 'job', 'result']);
    if (snapshot === null) throw invalidResponse();
    const job = normalizeRenderJob(snapshot.job);
    if (job.state !== 'succeeded') throw invalidResponse();
    return Object.freeze({
      event: 'completed',
      job,
      result: normalizeRenderResult(snapshot.result),
    });
  }
  if (eventName === 'cancelled') {
    const snapshot = snapshotExactRecord(eventSnapshot, ['event', 'job']);
    if (snapshot === null) throw invalidResponse();
    const job = normalizeRenderJob(snapshot.job);
    if (job.state !== 'cancelled') throw invalidResponse();
    return Object.freeze({ event: 'cancelled', job });
  }
  if (eventName === 'failed') {
    const snapshot = snapshotExactRecord(eventSnapshot, ['event', 'job', 'error']);
    if (snapshot === null) throw invalidResponse();
    const job = snapshot.job === null ? null : normalizeRenderJob(snapshot.job);
    if (job !== null && !['failed', 'succeeded'].includes(job.state)) throw invalidResponse();
    return Object.freeze({ event: 'failed', job, error: normalizeCommandError(snapshot.error) });
  }
  throw invalidResponse();
};

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  const allowed = new Set([
    'onEvent', 'onProgress', 'onCompleted', 'onCancelled', 'onFailed', 'onProtocolError',
  ]);
  const snapshot = snapshotPlainRecord(handlers);
  if (snapshot === null || !hasOnlyKeys(snapshot, allowed)
      || Object.values(snapshot).some(
        (handler) => handler !== undefined && typeof handler !== 'function'
      )) {
    throw invalidRequest();
  }
  return snapshot;
};

const callSafely = (handler, value) => {
  if (typeof handler !== 'function') return;
  try {
    const returned = handler(value);
    if (returned && typeof returned.catch === 'function') returned.catch(() => undefined);
  } catch {
    // Presentation callbacks never own the native render lifecycle.
  }
};

export const createNativeRenderService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();
  const transferredPlaybackIds = new Set();
  const quarantinedPlaybackIds = new Set();

  const requireNative = () => {
    if (!isNativeRuntime()) throw runtimeRequired();
  };

  /**
   * Whether this build can render video natively, and why not when it cannot.
   *
   * The response used to carry a fifth field naming the browser renderer's version, which this
   * module compared against a frozen constant of its own. That pinned a dead field: the native side
   * could not drop it without failing every readiness check in the editor. The comparison went
   * first and the field followed, so the shape is now the three things the answer is actually about.
   */
  const status = async () => {
    requireNative();
    try {
      const response = await invokeCommand('render_runtime_status', {});
      const value = snapshotExactRecord(response, ['available', 'reason', 'maxConcurrentRenders']);
      if (value === null
        || typeof value.available !== 'boolean'
        || (value.reason !== null && !RENDER_UNAVAILABLE_REASONS.has(value.reason))
        || value.maxConcurrentRenders !== 1
        || (value.available && value.reason !== null)
        || (!value.available && value.reason === null)) {
        throw invalidResponse();
      }
      return Object.freeze({ ...value });
    } catch (error) {
      throw normalizeFailure(error);
    }
  };

  const cancel = async (jobId) => {
    requireNative();
    const id = requireUuid(jobId, 7);
    try {
      const job = normalizeRenderJob(await invokeCommand('job_cancel', { id }));
      if (job.id !== id || !CANCELLATION_RESPONSE_STATES.has(job.state)) {
        throw invalidResponse();
      }
      return job;
    } catch (error) {
      throw normalizeFailure(error);
    }
  };

  const releasePlayback = async (playbackId) => {
    requireNative();
    const id = requireUuid(playbackId, 4);
    try {
      const released = await invokeCommand('render_playback_release', { playbackId: id });
      if (typeof released !== 'boolean') throw invalidResponse();
      return released;
    } catch (error) {
      throw normalizeFailure(error);
    }
  };

  const quarantinePlayback = async (playbackId) => {
    if (transferredPlaybackIds.has(playbackId) || quarantinedPlaybackIds.has(playbackId)) {
      return false;
    }
    quarantinedPlaybackIds.add(playbackId);
    try {
      await releasePlayback(playbackId);
      return true;
    } catch {
      return false;
    }
  };

  const getResult = async (jobId) => {
    requireNative();
    const id = requireUuid(jobId, 7);
    let rawResponse = null;
    try {
      rawResponse = await invokeCommand('render_result', { jobId: id });
      const response = normalizeRenderResultResponse(
        rawResponse
      );
      if (response.job.id !== id) throw invalidResponse();
      if (response.result !== null) {
        const playbackId = response.result.playback.id;
        if (transferredPlaybackIds.has(playbackId) || quarantinedPlaybackIds.has(playbackId)) {
          throw invalidResponse();
        }
        transferredPlaybackIds.add(playbackId);
      }
      return response;
    } catch (error) {
      const ownership = extractPlaybackOwnership(rawResponse);
      if (ownership !== null) await quarantinePlayback(ownership.playbackId);
      throw normalizeFailure(error);
    }
  };

  const start = async (request, rawHandlers, rawOptions = {}) => {
    requireNative();
    const ownedRequest = snapshotPlainRecord(request);
    if (ownedRequest === null
        || !uuidHasVersion(ownedRequest.sourceAssetId, 7)
        || !uuidHasVersion(ownedRequest.projectId, 7)) {
      throw invalidRequest();
    }
    const expectedSourceAssetId = ownedRequest.sourceAssetId;
    const expectedProjectId = ownedRequest.projectId;
    const options = snapshotPlainRecord(rawOptions);
    if (options === null
        || Object.keys(options).some((key) => !['signal', 'text'].includes(key))) {
      throw invalidRequest();
    }
    const signal = options.signal ?? null;
    const ownedText = options.text === undefined || options.text === null
      ? null
      : normalizeExportText(options.text, ownedRequest);
    const handlers = normalizeHandlers(rawHandlers);
    const channel = new ChannelConstructor();
    if (!isRecord(channel)) throw invalidRequest();
    const borrowedAbortMonitor = internalAbortMonitors.get(rawOptions) ?? null;
    const abortMonitor = borrowedAbortMonitor ?? createAbortMonitor(signal);
    const ownsAbortMonitor = borrowedAbortMonitor === null;
    if (abortMonitor?.isAborted()) {
      if (ownsAbortMonitor) abortMonitor.dispose();
      throw cancelled();
    }
    const pending = [];
    let initial = null;
    let lastSequence = null;
    let lastProgress = 0;
    let lastFraction = 0;
    let lastPhase = -1;
    let lastRenderedFrames = 0;
    let lastEncodedFrames = 0;
    let expectedDurationInFrames = null;
    let terminal = false;
    let protocolFailed = false;
    let protocolCancellation = null;
    const releasedPlaybacks = new Set();
    let transferredPlaybackId = null;

    const releaseUntransferredPlayback = (playbackId) => {
      if (playbackId === transferredPlaybackId) return;
      if (transferredPlaybackIds.has(playbackId)) return;
      if (releasedPlaybacks.has(playbackId)) return;
      releasedPlaybacks.add(playbackId);
      void quarantinePlayback(playbackId);
    };
    const quarantineCompletedPlayback = (value) => {
      const ownership = extractCompletedPlaybackOwnership(value);
      if (ownership !== null
          && (initial === null || ownership.jobId === null || ownership.jobId === initial.id)) {
        releaseUntransferredPlayback(ownership.playbackId);
      }
    };

    const issueCancellation = () => {
      if (initial === null || protocolCancellation !== null || terminal) {
        return protocolCancellation;
      }
      activeChannels.delete(initial.id);
      protocolCancellation = cancel(initial.id).catch(() => null);
      return protocolCancellation;
    };
    const onAbort = () => issueCancellation();
    let stopListeningForAbort = () => {};
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (initial !== null) activeChannels.delete(initial.id);
      try {
        stopListeningForAbort();
      } catch {
        // The internal observer is best-effort cleanup only.
      }
      if (ownsAbortMonitor) abortMonitor?.dispose();
    };
    stopListeningForAbort = abortMonitor?.listen(onAbort) ?? stopListeningForAbort;
    const protocolError = () => {
      if (protocolFailed) return;
      protocolFailed = true;
      for (const abandoned of pending.splice(0)) quarantineCompletedPlayback(abandoned);
      issueCancellation();
      if (initial !== null) release();
      callSafely(handlers.onProtocolError, invalidResponse());
    };
    const dispatch = (event) => {
      if (protocolFailed) return;
      const phase = event.event === 'progress' ? RENDER_PHASE_ORDER.get(event.phase) : null;
      if (terminal || event.job === null
          || event.job.id !== initial.id
          || event.job.sequence < lastSequence
          || event.job.progress.basisPoints < lastProgress
          || (event.event !== 'progress' && event.job.sequence <= lastSequence)
          || (event.event === 'progress' && (event.fractionMillionths < lastFraction
            || phase < lastPhase
            || (phase === lastPhase && (event.renderedFrames < lastRenderedFrames
              || event.encodedFrames < lastEncodedFrames))
            || (expectedDurationInFrames !== null
              && event.durationInFrames !== expectedDurationInFrames)))) {
        quarantineCompletedPlayback(event);
        protocolError();
        return;
      }
      if (event.event === 'completed'
          && (event.result.sourceAssetId !== expectedSourceAssetId
            || event.result.projectId !== expectedProjectId)) {
        releaseUntransferredPlayback(event.result.playback.id);
        protocolError();
        return;
      }
      lastSequence = event.job.sequence;
      lastProgress = event.job.progress.basisPoints;
      if (event.event === 'progress') {
        lastFraction = event.fractionMillionths;
        lastPhase = phase;
        lastRenderedFrames = event.renderedFrames;
        lastEncodedFrames = event.encodedFrames;
        expectedDurationInFrames ??= event.durationInFrames;
      }
      const isTerminalEvent = event.event !== 'progress';
      if (isTerminalEvent) terminal = true;
      if (event.event === 'completed') {
        if (typeof handlers.onEvent === 'function' || typeof handlers.onCompleted === 'function') {
          transferredPlaybackId = event.result.playback.id;
          transferredPlaybackIds.add(transferredPlaybackId);
        } else {
          releaseUntransferredPlayback(event.result.playback.id);
        }
      }
      if (isTerminalEvent) release();
      callSafely(handlers.onEvent, event);
      if (event.event === 'progress') callSafely(handlers.onProgress, event);
      if (event.event === 'completed') callSafely(handlers.onCompleted, event);
      if (event.event === 'cancelled') callSafely(handlers.onCancelled, event);
      if (event.event === 'failed') callSafely(handlers.onFailed, event);
    };
    const dispatchBuffered = () => {
      for (const event of pending.splice(0)) {
        if (protocolFailed || terminal) quarantineCompletedPlayback(event);
        else dispatch(event);
      }
    };
    channel.onmessage = (rawEvent) => {
      if (protocolFailed || terminal) {
        quarantineCompletedPlayback(rawEvent);
        return;
      }
      let event;
      try {
        event = normalizeRenderEvent(rawEvent);
      } catch {
        quarantineCompletedPlayback(rawEvent);
        protocolError();
        return;
      }
      if (initial === null) {
        if (pending.length >= MAX_PENDING_EVENTS) {
          quarantineCompletedPlayback(event);
          protocolError();
        } else {
          pending.push(event);
        }
        return;
      }
      dispatch(event);
    };

    let rawInitial;
    try {
      rawInitial = await invokeCommand('render_start', ownedText === null
        ? { request: ownedRequest, onEvent: channel }
        : { request: ownedRequest, text: ownedText, onEvent: channel });
    } catch (error) {
      if (!protocolFailed && pending.length > 0 && pending[0].job !== null) {
        initial = pending[0].job;
        lastSequence = -1;
        lastProgress = 0;
        lastFraction = 0;
        dispatchBuffered();
        if (!terminal) await issueCancellation();
      } else {
        for (const event of pending.splice(0)) quarantineCompletedPlayback(event);
      }
      release();
      throw normalizeFailure(error);
    }
    try {
      initial = normalizeRenderJob(rawInitial);
    } catch (error) {
      const snapshot = snapshotPlainRecord(rawInitial)?.id ?? null;
      if (uuidHasVersion(snapshot, 7)) {
        initial = Object.freeze({ id: snapshot });
        await issueCancellation();
      }
      for (const event of pending.splice(0)) quarantineCompletedPlayback(event);
      release();
      throw error;
    }
    if (initial.state !== 'running') {
      if (ACTIVE_JOB_STATES.has(initial.state)) await issueCancellation();
      for (const event of pending.splice(0)) quarantineCompletedPlayback(event);
      release();
      throw invalidResponse();
    }
    lastSequence = initial.sequence;
    lastProgress = initial.progress.basisPoints;
    if (protocolFailed || abortMonitor?.isAborted()) {
      await issueCancellation();
      for (const event of pending.splice(0)) quarantineCompletedPlayback(event);
      release();
      throw protocolFailed ? invalidResponse() : cancelled();
    }
    activeChannels.set(initial.id, channel);
    dispatchBuffered();
    if (protocolFailed) {
      await issueCancellation();
      release();
      throw invalidResponse();
    }
    return initial;
  };

  return Object.freeze({ status, start, getResult, cancel, releasePlayback });
};

const nativeRenderService = createNativeRenderService();

export const getNativeRenderStatus = nativeRenderService.status;
export const startNativeRender = nativeRenderService.start;
export const getNativeRenderResult = nativeRenderService.getResult;
export const cancelNativeRender = nativeRenderService.cancel;
export const releaseNativeRenderPlayback = nativeRenderService.releasePlayback;

const runNativeRenderObserved = async (
  request,
  { signal, text, onStarted, onProgress },
  service,
  abortMonitor,
) => {
  const ownership = snapshotPlainRecord(request);
  if (ownership === null
      || !uuidHasVersion(ownership.sourceAssetId, 7)
      || !uuidHasVersion(ownership.projectId, 7)) {
    throw invalidRequest();
  }
  const expectedSourceAssetId = ownership.sourceAssetId;
  const expectedProjectId = ownership.projectId;
  if (abortMonitor?.isAborted()) throw cancelled();
  let terminalObserved = false;
  let terminalOutcome = null;
  let resolveTerminal;
  const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
  const settle = (outcome) => {
    if (terminalOutcome !== null) return;
    terminalObserved = true;
    terminalOutcome = outcome;
    resolveTerminal(outcome);
  };
  let initial;
  try {
    initial = await service.start(request, {
      onProgress,
      onCompleted: (event) => settle({ result: event }),
      onCancelled: () => settle({ error: cancelled() }),
      onFailed: async (event) => {
        terminalObserved = true;
        if (event.job?.state === 'succeeded') {
          if (abortMonitor?.isAborted()) {
            settle({ error: cancelled() });
            return;
          }
          try {
            const recovered = await service.getResult(event.job.id);
            if (recovered.result !== null) {
              if (abortMonitor?.isAborted()) {
                if (typeof service.releasePlayback === 'function') {
                  try {
                    await service.releasePlayback(recovered.result.playback.id);
                  } catch {
                    // Cancellation owns the result even if capability cleanup is already complete.
                  }
                }
                settle({ error: cancelled() });
                return;
              }
              if (recovered.result.sourceAssetId !== expectedSourceAssetId
                  || recovered.result.projectId !== expectedProjectId) {
                if (typeof service.releasePlayback === 'function') {
                  try {
                    await service.releasePlayback(recovered.result.playback.id);
                  } catch {
                    // The categorical protocol failure still owns this boundary.
                  }
                }
                settle({ error: invalidResponse() });
                return;
              }
              settle({
                result: Object.freeze({
                  event: 'completed',
                  job: recovered.job,
                  result: recovered.result,
                }),
              });
              return;
            }
          } catch {
            if (abortMonitor?.isAborted()) {
              settle({ error: cancelled() });
              return;
            }
            // Fall through to the categorical native failure.
          }
        }
        settle({ error: normalizeFailure(event.error) });
      },
      onProtocolError: (error) => settle({ error }),
    }, (() => {
      const startOptions = text === undefined ? { signal } : { signal, text };
      if (abortMonitor !== null) internalAbortMonitors.set(startOptions, abortMonitor);
      return startOptions;
    })());
  } catch (error) {
    if (!terminalObserved) throw normalizeFailure(error);
    const outcome = terminalOutcome ?? await terminal;
    if (outcome.error) throw outcome.error;
    return outcome.result;
  }
  if (!terminalObserved) callSafely(onStarted, initial);
  const outcome = await terminal;
  if (outcome.error) throw outcome.error;
  return outcome.result;
};

export const runNativeRender = async (
  request,
  rawOptions = {},
  service = nativeRenderService,
) => {
  const options = snapshotPlainRecord(rawOptions);
  const allowed = new Set(['signal', 'text', 'onStarted', 'onProgress']);
  if (options === null || Object.keys(options).some((key) => !allowed.has(key))) {
    throw invalidRequest();
  }
  const signal = options.signal ?? null;
  const text = options.text;
  const onStarted = options.onStarted;
  const onProgress = options.onProgress;
  if ((onStarted !== undefined && typeof onStarted !== 'function')
      || (onProgress !== undefined && typeof onProgress !== 'function')) {
    throw invalidRequest();
  }
  const abortMonitor = createAbortMonitor(signal);
  try {
    return await runNativeRenderObserved(
      request,
      { signal, text, onStarted, onProgress },
      service,
      abortMonitor,
    );
  } finally {
    abortMonitor?.dispose();
  }
};

const abortableDelay = (milliseconds, abortMonitor) => new Promise((resolve, reject) => {
  if (abortMonitor?.isAborted()) {
    reject(cancelled());
    return;
  }
  let timer = null;
  let settled = false;
  let stopListening = () => {};
  const cleanup = () => {
    try {
      stopListening();
    } catch {
      // The internal observer is best-effort cleanup only.
    }
  };
  const onAbort = () => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    cleanup();
    reject(cancelled());
  };
  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve();
  }, milliseconds);
  stopListening = abortMonitor?.listen(onAbort) ?? stopListening;
  if (settled && timer !== null) clearTimeout(timer);
});

const waitForNativeRenderObserved = async (jobId, {
  pollIntervalMs,
  timeoutMs,
  onUpdate,
}, service, abortMonitor) => {
  requireInteger(pollIntervalMs, 100, 10_000);
  requireInteger(timeoutMs, pollIntervalMs, MAX_POLL_MS);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (abortMonitor?.isAborted()) throw cancelled();
    const response = await service.getResult(jobId);
    if (abortMonitor?.isAborted()) {
      const playbackId = response?.result?.playback?.id;
      if (uuidHasVersion(playbackId, 4) && typeof service.releasePlayback === 'function') {
        try {
          await service.releasePlayback(playbackId);
        } catch {
          // Cancellation remains authoritative even if capability cleanup is already complete.
        }
      }
      throw cancelled();
    }
    callSafely(onUpdate, response);
    if (!ACTIVE_JOB_STATES.has(response.job.state)) return response;
    await abortableDelay(pollIntervalMs, abortMonitor);
  }
  throw new NativeRenderError('renderTimeout', 'The native render status wait timed out');
};

export const waitForNativeRender = async (
  jobId,
  rawOptions = {},
  service = nativeRenderService,
) => {
  const options = snapshotPlainRecord(rawOptions);
  const allowed = new Set(['signal', 'pollIntervalMs', 'timeoutMs', 'onUpdate']);
  if (options === null || Object.keys(options).some((key) => !allowed.has(key))) {
    throw invalidRequest();
  }
  const signal = options.signal ?? null;
  const pollIntervalMs = options.pollIntervalMs === undefined ? 750 : options.pollIntervalMs;
  const timeoutMs = options.timeoutMs === undefined ? MAX_POLL_MS : options.timeoutMs;
  const onUpdate = options.onUpdate;
  if (onUpdate !== undefined && typeof onUpdate !== 'function') throw invalidRequest();
  const abortMonitor = createAbortMonitor(signal);
  try {
    return await waitForNativeRenderObserved(
      jobId,
      { pollIntervalMs, timeoutMs, onUpdate },
      service,
      abortMonitor,
    );
  } finally {
    abortMonitor?.dispose();
  }
};
