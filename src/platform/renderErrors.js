// The native render error type, its fixed refusal vocabulary, and the sentences a user is shown.

export const RENDER_COMMAND_CODES = new Set([
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

export class NativeRenderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeRenderError';
    this.code = code;
  }
}

export const invalidRequest = (validationPath = null) => {
  const error = new NativeRenderError(
    'invalidRenderRequest',
    'The native video render request is invalid',
  );
  if (typeof validationPath === 'string' && validationPath.length > 0) {
    error.validationPath = validationPath;
  }
  return error;
};

export const validateRequestPart = (validationPath, validator) => {
  try {
    return validator();
  } catch (error) {
    if (error instanceof NativeRenderError && error.code === 'invalidRenderRequest') {
      throw invalidRequest(error.validationPath ?? validationPath);
    }
    throw error;
  }
};

export const invalidResponse = () => new NativeRenderError(
  'invalidRenderResponse',
  'The desktop host returned invalid native render data'
);

export const runtimeRequired = () => new NativeRenderError(
  'desktopRenderRequired',
  'Native video rendering requires the desktop runtime'
);

export const cancelled = () => {
  const error = new NativeRenderError('renderCancelled', 'The native video render was cancelled');
  error.name = 'AbortError';
  return error;
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
 * Exported for the contract guard in `renderErrors.test.js`, which reads the code vocabulary out of
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

export const normalizeFailure = (value) => {
  try {
    if (value instanceof NativeRenderError) return value;
  } catch {
    // Hostile transport proxies are never authoritative error metadata.
  }
  const code = allowedRenderCode(value);
  return new NativeRenderError(code, renderFailureMessage(code));
};
