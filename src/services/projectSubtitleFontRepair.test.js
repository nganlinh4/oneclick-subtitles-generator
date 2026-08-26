import { describe, expect, test, vi } from 'vitest';

import { DEFAULT_SUBTITLE_FONT_FAMILY } from '../shared/subtitle/defaultSubtitleFont';
import { FONT_READINESS_CONTRACT_MISMATCH } from './fontCapability';
import {
  PROJECT_SUBTITLE_FONT_ADMISSION,
  inspectProjectSubtitleFontAdmission,
  planProjectSubtitleFontRepair,
} from './projectSubtitleFontRepair';

const settledCapability = (managedPackInstalled) => Object.freeze({
  published: true,
  pending: false,
  managedPackInstalled,
});

describe('planProjectSubtitleFontRepair', () => {
  test('admits an exact reviewed system face without waiting for the unrelated managed pack', () => {
    const admission = inspectProjectSubtitleFontAdmission({
      fontFamily: "'Arial', sans-serif",
      fontWeight: 400,
      capability: { published: true, pending: true, managedPackInstalled: false },
      platform: 'windows',
      isSystemFaceInstalled: ({ family, weight }) => family === 'Arial' && weight === 400,
    });

    expect(admission.status).toBe(PROJECT_SUBTITLE_FONT_ADMISSION.ready);
    expect(admission.repair).toBeNull();
    expect(admission.resolution.status).toBe('exact');
  });

  test('classifies an unresolved managed face as preparing rather than a refusal', () => {
    expect(inspectProjectSubtitleFontAdmission({
      fontFamily: DEFAULT_SUBTITLE_FONT_FAMILY,
      fontWeight: 400,
      capability: { published: true, pending: true, managedPackInstalled: false },
      platform: 'windows',
      isSystemFaceInstalled: () => false,
    })).toMatchObject({
      status: PROJECT_SUBTITLE_FONT_ADMISSION.preparing,
      repair: null,
      resolution: { status: 'unavailable' },
    });
  });

  test('returns after one exact lookup without enumerating weights or fallbacks', () => {
    const resolve = vi.fn(() => ({ status: 'exact', identity: {} }));
    const enumerateWeights = vi.fn(() => {
      throw new Error('an exact selection must not scan weights');
    });

    expect(planProjectSubtitleFontRepair({
      fontFamily: "'Arial', sans-serif",
      fontWeight: 400,
      capability: settledCapability(false),
      platform: 'windows',
      isSystemFaceInstalled: null,
      resolve,
      enumerateWeights,
    })).toBeNull();
    expect(resolve).toHaveBeenCalledOnce();
    expect(enumerateWeights).not.toHaveBeenCalled();
  });

  test.each([
    [{ published: false, pending: true, managedPackInstalled: false }, 'unpublished'],
    [{ published: true, pending: true, managedPackInstalled: false }, 'pending'],
  ])('does not guess or enumerate fallbacks while managed readiness is %s', (capability) => {
    const resolve = vi.fn(() => ({ status: 'unavailable', reason: 'weight-not-in-face' }));
    const enumerateWeights = vi.fn(() => {
      throw new Error('pending readiness must not enumerate repair candidates');
    });
    expect(planProjectSubtitleFontRepair({
      fontFamily: "'Impact', sans-serif",
      fontWeight: 700,
      capability,
      platform: 'windows',
      isSystemFaceInstalled: () => true,
      resolve,
      enumerateWeights,
    })).toBeNull();
    expect(resolve).toHaveBeenCalledOnce();
    expect(enumerateWeights).not.toHaveBeenCalled();
  });

  test('preserves Impact and repairs an impossible 700 request to its nearest exact 400 face', () => {
    expect(planProjectSubtitleFontRepair({
      fontFamily: "'Impact', sans-serif",
      fontWeight: 700,
      capability: settledCapability(false),
      platform: 'windows',
      isSystemFaceInstalled: ({ family }) => family === 'Impact',
    })).toEqual({
      from: { fontFamily: "'Impact', sans-serif", fontWeight: 700 },
      to: { fontFamily: "'Impact', sans-serif", fontWeight: 400 },
      reason: 'nearestExactWeight',
    });
  });

  test('moves a dead legacy family to the exact managed default when its bytes are ready', () => {
    expect(planProjectSubtitleFontRepair({
      fontFamily: "'Definitely Missing', fantasy",
      fontWeight: 800,
      capability: settledCapability(true),
      platform: 'windows',
      isSystemFaceInstalled: () => false,
    })).toEqual({
      from: { fontFamily: "'Definitely Missing', fantasy", fontWeight: 800 },
      to: { fontFamily: DEFAULT_SUBTITLE_FONT_FAMILY, fontWeight: 400 },
      reason: 'managedDefault',
    });
  });

  test('uses the reviewed exact system fallback only after native refuses the managed pack', () => {
    expect(planProjectSubtitleFontRepair({
      fontFamily: "'Definitely Missing', fantasy",
      fontWeight: 800,
      capability: settledCapability(false),
      platform: 'windows',
      isSystemFaceInstalled: ({ family, weight }) => family === 'Arial' && weight === 400,
    })).toEqual({
      from: { fontFamily: "'Definitely Missing', fantasy", fontWeight: 800 },
      to: { fontFamily: "'Arial', sans-serif", fontWeight: 400 },
      reason: 'reviewedSystemFallback',
    });
  });

  test('refuses a protocol mismatch instead of laundering it into the system fallback', () => {
    const resolve = vi.fn(() => ({ status: 'unavailable', reason: 'managed-pack-unavailable' }));
    const enumerateWeights = vi.fn(() => [400]);

    expect(inspectProjectSubtitleFontAdmission({
      fontFamily: DEFAULT_SUBTITLE_FONT_FAMILY,
      fontWeight: 400,
      capability: {
        published: true,
        pending: false,
        managedPackInstalled: false,
        reason: FONT_READINESS_CONTRACT_MISMATCH,
      },
      platform: 'windows',
      isSystemFaceInstalled: () => true,
      resolve,
      enumerateWeights,
    })).toMatchObject({
      status: PROJECT_SUBTITLE_FONT_ADMISSION.refused,
      repair: null,
      resolution: {
        status: 'unavailable',
        reason: FONT_READINESS_CONTRACT_MISMATCH,
      },
    });
    expect(enumerateWeights).not.toHaveBeenCalled();
  });
});
