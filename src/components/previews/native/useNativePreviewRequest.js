/**
 * Everything a native preview frame needs, derived from what the editor already has.
 *
 * The editor holds a customization, a cue list, a source size, a crop and a playhead. The compositor
 * needs a composition size, a resolved face, a staged glyph atlas, a scene and a frame index. This
 * hook is that derivation, and it is deliberately the ONLY one: both preview surfaces call it, so
 * neither can grow a second opinion about how a style becomes a frame.
 *
 * DORMANCY IS NOT FAILURE, and the distinction is load-bearing. A face with no verified byte source,
 * a source whose dimensions are not known yet, a session with no desktop runtime — none of these are
 * errors to put in front of a user. They are states in which no native frame can be honestly
 * produced, so none is requested and the surface does not engage. An ERROR is reserved for work that
 * was actually attempted and refused. Reporting dormancy as failure would put a permanent banner
 * over an editor that is working correctly; hiding a refusal behind dormancy would be exactly the
 * silent substitution this migration exists to remove.
 *
 * EVERY DERIVED VALUE IS KEYED ON CONTENT, not on object identity. The editor hands these surfaces
 * freshly built arrays and objects on most renders — `getCurrentSubtitles()` returns a new array
 * every time it is called — and keying a bake on identity would re-bake and re-upload an atlas on
 * every keystroke elsewhere in the app. Content keys make the atlas revision mean what its name says.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { stageGlyphAtlas } from '../../../platform/glyphAtlasStaging';
import {
  compositionSize,
  exactFrameRate,
  frameCountForDuration,
  frameIndexForTime,
} from './nativePreviewGeometry';
import {
  atlasBakeRequest,
  bakePreviewAtlas,
  buildPreviewScene,
  previewCueList,
  previewFace,
  selectPreviewCue,
} from './nativePreviewScene';

/** The three platforms `src/services/fontIdentity.js` has reviewed declaration sets for. */
const detectPlatform = () => {
  const agent = typeof navigator === 'object' && typeof navigator.userAgent === 'string'
    ? navigator.userAgent.toLowerCase()
    : '';
  if (agent.includes('windows')) return 'windows';
  if (agent.includes('mac os') || agent.includes('macintosh')) return 'macos';
  if (agent.includes('linux') || agent.includes('x11')) return 'linux';
  return null;
};

/**
 * Corroboration only, and only in the rejecting direction: `resolveFontIdentity` treats a `false`
 * as a missing face and never lets a `true` override a declaration it does not have.
 */
const faceInstalledProbe = () => {
  if (typeof document !== 'object' || typeof document.fonts?.check !== 'function') return null;
  return ({ family, weight }) => {
    try {
      return document.fonts.check(`${weight} 16px "${family}"`);
    } catch {
      return false;
    }
  };
};

const DORMANT = Object.freeze({ scene: null, atlas: null, frameIndex: null, error: null });

/** The customization fields a bake actually reads, as one comparable key. */
const styleKeyOf = (customization) => JSON.stringify([
  customization?.fontSize ?? null,
  customization?.lineHeight ?? null,
  customization?.letterSpacing ?? null,
  customization?.textAlign ?? null,
  customization?.textTransform ?? null,
  customization?.wordWrap ?? null,
  customization?.maxWidth ?? null,
]);

const useNativePreviewRequest = ({
  active = true,
  customization = null,
  subtitles = null,
  resolution = null,
  frameRate = null,
  cropWidthPercent = 100,
  cropHeightPercent = 100,
  sourceWidthPx = null,
  sourceHeightPx = null,
  durationSeconds = null,
  currentTime = 0,
}) => {
  const [staged, setStaged] = useState(null);
  const [atlasError, setAtlasError] = useState(null);

  const fontFamily = customization?.fontFamily ?? null;
  const fontWeight = customization?.fontWeight ?? null;
  const fadeInDuration = customization?.fadeInDuration ?? 0;
  const fadeOutDuration = customization?.fadeOutDuration ?? 0;
  const styleKey = styleKeyOf(customization);

  const face = useMemo(() => {
    const platform = detectPlatform();
    if (platform === null) return null;
    return previewFace({
      fontFamily,
      fontWeight,
      platform,
      isSystemFaceInstalled: faceInstalledProbe(),
    });
  }, [fontFamily, fontWeight]);

  const composition = useMemo(
    () => compositionSize({
      resolution,
      sourceWidthPx,
      sourceHeightPx,
      crop: { width: cropWidthPercent, height: cropHeightPercent },
    }),
    [resolution, sourceWidthPx, sourceHeightPx, cropWidthPercent, cropHeightPercent],
  );

  const timeline = useMemo(() => {
    const rate = exactFrameRate(frameRate);
    if (rate === null) return null;
    const frameCount = frameCountForDuration(durationSeconds, rate);
    return frameCount === null ? null : Object.freeze({ ...rate, frameCount });
  }, [frameRate, durationSeconds]);

  // Content-keyed: the cue list is rebuilt from a fresh array on most renders, but the selected cue
  // only changes when the text or its bounds change, which is the only thing a bake depends on.
  const cues = useMemo(() => previewCueList(subtitles), [subtitles]);
  const selected = selectPreviewCue(cues, currentTime, { fadeInDuration, fadeOutDuration });
  const cueKey = selected === null ? '' : JSON.stringify([selected.text, selected.start, selected.end]);
  const stableCue = useMemo(() => {
    if (cueKey === '') return null;
    const [text, start, end] = JSON.parse(cueKey);
    return Object.freeze({ text, start, end });
  }, [cueKey]);

  const bake = useMemo(() => {
    if (!active || face === null || composition === null || customization === null) return null;
    return atlasBakeRequest({
      customization,
      text: stableCue === null ? '' : stableCue.text,
      compositionWidthPx: composition.widthPx,
      compositionHeightPx: composition.heightPx,
      face,
    });
    // `customization` is read only through `styleKey`; depending on the object would re-bake on
    // every render the editor happens to rebuild it on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, face, composition, styleKey, stableCue]);

  const liveRef = useRef(false);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (bake === null) return undefined;
    let superseded = false;
    let descriptor;
    try {
      descriptor = bakePreviewAtlas(bake);
    } catch (error) {
      // A refusal to bake is the honest unavailable the migration produces instead of a silent
      // substitution: the face does not cover the text, or the surface cannot verify a face at all.
      setStaged(null);
      setAtlasError(Object.freeze({ code: error?.code ?? 'glyphAtlasUnavailable' }));
      return undefined;
    }
    stageGlyphAtlas(descriptor).then(
      (handle) => {
        if (superseded || !liveRef.current) return;
        setStaged(Object.freeze({ handle, bake }));
        setAtlasError(null);
      },
      (error) => {
        if (superseded || !liveRef.current) return;
        setStaged(null);
        setAtlasError(Object.freeze({ code: error?.code ?? 'glyphAtlasStagingRejected' }));
      },
    );
    return () => {
      superseded = true;
    };
  }, [bake]);

  const scene = useMemo(() => {
    if (composition === null || timeline === null || face === null) return null;
    return buildPreviewScene({
      compositionWidthPx: composition.widthPx,
      compositionHeightPx: composition.heightPx,
      timeline,
      face,
      cue: stableCue,
    });
  }, [composition, timeline, face, stableCue]);

  const frameIndex = useMemo(
    () => (timeline === null ? null : frameIndexForTime(currentTime, timeline)),
    [timeline, currentTime],
  );

  // The staged atlas and the scene must describe the same revision. A handle left over from the
  // previous cue paired with this cue's scene would draw the previous cue's run, so a mismatch is
  // dormant rather than "close enough".
  const paired = staged !== null && staged.bake === bake;
  if (!active || scene === null || !paired) {
    return atlasError === null ? DORMANT : { ...DORMANT, error: atlasError };
  }
  return { scene, atlas: staged.handle, frameIndex, error: null };
};

export default useNativePreviewRequest;
