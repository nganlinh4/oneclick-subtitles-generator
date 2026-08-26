import { fontCapabilitySnapshot } from './fontCapability';
import {
  parseFontFamilyValue,
  resolveFontIdentity,
  sameFontIdentity,
} from './fontIdentity';
import {
  DEFAULT_SUBTITLE_FONT_FAMILY,
  DEFAULT_SUBTITLE_FONT_NAME,
} from '../shared/subtitle/defaultSubtitleFont';
import { systemFontProbe } from '../platform/systemFontProbe';

export { systemFontProbe };

const FONT_WEIGHTS = Object.freeze([400, 700, 300, 500, 600, 800, 900, 100, 200]);
export const FONT_WEIGHT_VALUES = Object.freeze([100, 200, 300, 400, 500, 600, 700, 800, 900]);

export const fontPlatform = (userAgent = typeof navigator === 'object' ? navigator.userAgent : '') => {
  const agent = String(userAgent).toLowerCase();
  if (agent.includes('windows')) return 'windows';
  if (agent.includes('mac os') || agent.includes('macintosh')) return 'macos';
  if (agent.includes('linux') || agent.includes('x11')) return 'linux';
  return null;
};

/**
 * The native renderer identifies a face by the primary family. CSS fallback lists are disclosure,
 * not identity: the renderer deliberately refuses to walk them. The picker used to compare the
 * entire persisted CSS string instead, so the valid default (`'Google Sans', sans-serif`) could be
 * drawn while its own control said "Select Font" because the legacy catalog happened to spell a
 * longer fallback list.
 */
export const fontSelectionPrimaryFamily = (fontFamily) => {
  const parsed = parseFontFamilyValue(fontFamily);
  return parsed.ok ? parsed.primary : null;
};

/**
 * Return only font choices the running renderer can actually bake, each with a usable weight.
 *
 * The legacy picker advertised 121 choices while the packaged Windows renderer had byte identity
 * for only the managed face and reviewed OS faces. Selecting any other card persisted a state that
 * preview and export were required to refuse. Availability is now enforced before the click rather
 * than reported after the video has already stopped showing subtitles.
 */
export const selectableFontOptions = (options, {
  requestedWeight = 400,
  platform = fontPlatform(),
  capability = fontCapabilitySnapshot(),
  isSystemFaceInstalled = systemFontProbe(),
  declarations = {},
} = {}) => {
  if (!Array.isArray(options) || platform === null) return [];
  const weights = [requestedWeight, ...FONT_WEIGHTS.filter((weight) => weight !== requestedWeight)];
  const selectable = [];
  for (const option of options) {
    for (const weight of weights) {
      const result = resolveFontIdentity({
        fontFamily: option?.value,
        fontWeight: weight,
        fontStyle: 'normal',
        platform,
        managedPackInstalled: capability.managedPackInstalled,
        isSystemFaceInstalled,
        declarations,
      });
      if (result.status !== 'exact') continue;

      // The legacy catalog repeats several faces in multiple marketing categories. They resolve to
      // the same bytes and must be one choice, not several apparently different fonts.
      const duplicate = selectable.some(choice => (
        sameFontIdentity(choice.resolvedIdentity, result.identity)
      ));
      if (!duplicate) {
        selectable.push({
          ...option,
          // Persist the one canonical managed-font spelling shared by defaults and render requests.
          value: result.identity.family === DEFAULT_SUBTITLE_FONT_NAME
            ? DEFAULT_SUBTITLE_FONT_FAMILY
            : option.value,
          resolvedWeight: weight,
          resolvedIdentityKey: result.identity.key,
          resolvedIdentity: result.identity,
        });
      }
      break;
    }
  }
  return selectable;
};

/**
 * Return the exact weights the native renderer can bake for one selected face.
 *
 * A universal 100..900 slider used to manufacture requests that were impossible for discrete
 * system faces (Impact is 400-only in the reviewed Windows contract). Keeping this calculation in
 * the same resolver-backed service as the family picker prevents the two controls from drifting.
 */
export const selectableFontWeights = ({
  fontFamily,
  fontStyle = 'normal',
  platform = fontPlatform(),
  capability = fontCapabilitySnapshot(),
  isSystemFaceInstalled = systemFontProbe(),
  declarations = {},
} = {}) => {
  if (platform === null) return Object.freeze([]);
  return Object.freeze(FONT_WEIGHT_VALUES.filter((fontWeight) => (
    resolveFontIdentity({
      fontFamily,
      fontWeight,
      fontStyle,
      platform,
      managedPackInstalled: capability.managedPackInstalled,
      isSystemFaceInstalled,
      declarations,
    }).status === 'exact'
  )));
};

/** Resolve only the closed control's current value. This stays O(1) in runtime probes. */
export const currentFontSelection = (options, {
  fontFamily,
  fontWeight,
  fontStyle = 'normal',
  platform = fontPlatform(),
  capability = fontCapabilitySnapshot(),
  isSystemFaceInstalled = systemFontProbe(),
  declarations = {},
} = {}) => {
  const selectedResolution = resolveFontIdentity({
    fontFamily,
    fontWeight,
    fontStyle,
    platform,
    managedPackInstalled: capability.managedPackInstalled,
    isSystemFaceInstalled,
    declarations,
  });
  const displayOption = selectedResolution.status === 'exact' && Array.isArray(options)
    ? options.find(option => (
      fontSelectionPrimaryFamily(option?.value) === selectedResolution.identity.family
    )) ?? null
    : null;
  return Object.freeze({
    displayOption,
    selectedResolution,
    displayName: displayOption?.label ?? fontSelectionPrimaryFamily(fontFamily),
  });
};

/**
 * One renderer-backed model for both the closed selector and its modal.
 *
 * Card resolution may choose a supported weight because clicking the card commits that weight.
 * The currently persisted selection may not: it is selected only when its exact requested weight,
 * style, source and bytes resolve. This prevents an unavailable Arial 600 request from looking like
 * the available Arial 400 card.
 */
export const fontSelectionModel = (options, {
  fontFamily,
  fontWeight,
  fontStyle = 'normal',
  platform = fontPlatform(),
  capability = fontCapabilitySnapshot(),
  isSystemFaceInstalled = systemFontProbe(),
  declarations = {},
} = {}) => {
  const current = currentFontSelection(options, {
    fontFamily,
    fontWeight,
    fontStyle,
    platform,
    capability,
    isSystemFaceInstalled,
    declarations,
  });
  const selectable = selectableFontOptions(options, {
    requestedWeight: fontWeight,
    platform,
    capability,
    isSystemFaceInstalled,
    declarations,
  });
  const selectedOption = current.selectedResolution.status === 'exact'
    ? selectable.find(option => sameFontIdentity(
      option.resolvedIdentity,
      current.selectedResolution.identity,
    )) ?? null
    : null;
  return Object.freeze({
    options: Object.freeze(selectable),
    selectedOption,
    selectedResolution: current.selectedResolution,
    displayName: current.displayName,
  });
};

export const fontChoiceMatchesSelection = (choice, selectionModel) => (
  choice?.resolvedIdentity !== undefined
  && selectionModel?.selectedResolution?.status === 'exact'
  && sameFontIdentity(choice.resolvedIdentity, selectionModel.selectedResolution.identity)
);
