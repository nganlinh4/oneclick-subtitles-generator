import { defaultSubtitleCustomization } from '../shared/subtitle/subtitleCustomizationDefaults';
import { DEFAULT_SUBTITLE_FONT_FAMILY } from '../shared/subtitle/defaultSubtitleFont';
import { FONT_READINESS_CONTRACT_MISMATCH } from './fontCapability';
import { resolveFontIdentity } from './fontIdentity';
import {
  fontPlatform,
  fontSelectionPrimaryFamily,
  selectableFontWeights,
  systemFontProbe,
} from './selectableFonts';

const FONT_STYLE = 'normal';
const REVIEWED_SYSTEM_FALLBACK = Object.freeze({
  fontFamily: "'Arial', sans-serif",
  fontWeight: 400,
});

export const PROJECT_SUBTITLE_FONT_ADMISSION = Object.freeze({
  preparing: 'preparing',
  repairing: 'repairing',
  ready: 'ready',
  refused: 'refused',
});

const settledCapability = (capability) => (
  capability?.published === true
  && capability.pending === false
  && typeof capability.managedPackInstalled === 'boolean'
);

const exactResolution = ({
  fontFamily,
  fontWeight,
  platform,
  capability,
  isSystemFaceInstalled,
  declarations,
  resolve,
}) => resolve({
  fontFamily,
  fontWeight,
  fontStyle: FONT_STYLE,
  platform,
  managedPackInstalled: capability?.managedPackInstalled,
  isSystemFaceInstalled,
  declarations,
});

const nearestWeight = (weights, requestedWeight) => weights.reduce((nearest, candidate) => {
  if (nearest === null) return candidate;
  const candidateDistance = Math.abs(candidate - requestedWeight);
  const nearestDistance = Math.abs(nearest - requestedWeight);
  return candidateDistance < nearestDistance
    || (candidateDistance === nearestDistance && candidate < nearest)
    ? candidate
    : nearest;
}, null);

const repairPlan = (from, to, reason) => Object.freeze({
  from: Object.freeze({ ...from }),
  to: Object.freeze({ ...to }),
  reason,
});

/**
 * Inspect whether a persisted face may be submitted, without substituting at render time.
 *
 * The exact selection is checked first and returns in O(1). Only a broken selection enumerates the
 * nine legal weights. A family with at least one exact face keeps its spelling and moves to the
 * nearest real weight; a dead family moves to the verified managed default, then to the one reviewed
 * Windows system fallback when native positively reports that the managed pack is unavailable.
 */
export const inspectProjectSubtitleFontAdmission = ({
  fontFamily,
  fontWeight,
  capability,
  platform = fontPlatform(),
  isSystemFaceInstalled,
  declarations = {},
  resolve = resolveFontIdentity,
  enumerateWeights = selectableFontWeights,
} = {}) => {
  if (platform === null) {
    return Object.freeze({
      status: PROJECT_SUBTITLE_FONT_ADMISSION.preparing,
      repair: null,
      resolution: null,
    });
  }

  const probe = isSystemFaceInstalled === undefined ? systemFontProbe() : isSystemFaceInstalled;
  const current = exactResolution({
    fontFamily,
    fontWeight,
    platform,
    capability,
    isSystemFaceInstalled: probe,
    declarations,
    resolve,
  });
  // A reviewed system face does not depend on the managed package. Admit it immediately even while
  // native is preparing that unrelated package; this keeps an exact Arial/Impact project from
  // acquiring an artificial startup delay.
  if (current.status === 'exact') {
    return Object.freeze({
      status: PROJECT_SUBTITLE_FONT_ADMISSION.ready,
      repair: null,
      resolution: current,
    });
  }

  // An incompatible native publication is not evidence that the managed package is absent. It is
  // a frontend/native protocol failure, and laundering it into the ordinary Arial fallback would
  // durably rewrite a valid managed-font project merely because two app halves disagree. Exact
  // system faces were already admitted above because they do not consume this capability at all.
  if (capability?.reason === FONT_READINESS_CONTRACT_MISMATCH) {
    return Object.freeze({
      status: PROJECT_SUBTITLE_FONT_ADMISSION.refused,
      repair: null,
      resolution: Object.freeze({ ...current, reason: FONT_READINESS_CONTRACT_MISMATCH }),
    });
  }

  // No native answer is not an absent managed font. Waiting avoids rewriting a valid managed
  // selection while startup is still verifying or repairing its package.
  if (!settledCapability(capability)) {
    return Object.freeze({
      status: PROJECT_SUBTITLE_FONT_ADMISSION.preparing,
      repair: null,
      resolution: current,
    });
  }

  const exactWeights = enumerateWeights({
    fontFamily,
    fontStyle: FONT_STYLE,
    platform,
    capability,
    isSystemFaceInstalled: probe,
    declarations,
  });
  const familyWeight = nearestWeight(exactWeights, fontWeight);
  if (familyWeight !== null) {
    return Object.freeze({
      status: PROJECT_SUBTITLE_FONT_ADMISSION.repairing,
      repair: repairPlan(
        { fontFamily, fontWeight },
        { fontFamily, fontWeight: familyWeight },
        'nearestExactWeight',
      ),
      resolution: current,
    });
  }

  const managedDefault = {
    fontFamily: DEFAULT_SUBTITLE_FONT_FAMILY,
    fontWeight: defaultSubtitleCustomization.fontWeight,
  };
  if (exactResolution({
    ...managedDefault,
    platform,
    capability,
    isSystemFaceInstalled: probe,
    declarations,
    resolve,
  }).status === 'exact') {
    return Object.freeze({
      status: PROJECT_SUBTITLE_FONT_ADMISSION.repairing,
      repair: repairPlan(
        { fontFamily, fontWeight },
        managedDefault,
        'managedDefault',
      ),
      resolution: current,
    });
  }

  if (exactResolution({
    ...REVIEWED_SYSTEM_FALLBACK,
    platform,
    capability,
    isSystemFaceInstalled: probe,
    declarations,
    resolve,
  }).status === 'exact') {
    return Object.freeze({
      status: PROJECT_SUBTITLE_FONT_ADMISSION.repairing,
      repair: repairPlan(
        { fontFamily, fontWeight },
        REVIEWED_SYSTEM_FALLBACK,
        'reviewedSystemFallback',
      ),
      resolution: current,
    });
  }

  // If even the reviewed fallback cannot be proven, retaining the explicit refusal is safer than
  // persisting a second guess that preview and export would also have to reject.
  return Object.freeze({
    status: PROJECT_SUBTITLE_FONT_ADMISSION.refused,
    repair: null,
    resolution: current,
  });
};

export const planProjectSubtitleFontRepair = (options = {}) => {
  const admission = inspectProjectSubtitleFontAdmission(options);
  return admission.status === PROJECT_SUBTITLE_FONT_ADMISSION.repairing
    ? admission.repair
    : null;
};

export const formatProjectSubtitleFontSelection = ({ fontFamily, fontWeight }) => {
  const family = fontSelectionPrimaryFamily(fontFamily) ?? String(fontFamily);
  return `${family} ${fontWeight}`;
};
