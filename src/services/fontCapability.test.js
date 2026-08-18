import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SUBTITLE_FONT_FAMILY,
  DEFAULT_SUBTITLE_FONT_NAME,
  MANAGED_PACK_STATE,
  fontCapabilitySnapshot,
} from './fontCapability';
import { MANAGED_FONT_PACKAGE, UNAVAILABLE_REASON, resolveFontIdentity } from './fontIdentity';
import { defaultSubtitleCustomization } from '../shared/subtitle/subtitleCustomizationDefaults';
import { previewFace } from '../components/previews/native/nativePreviewScene';

/**
 * The regression for the defect that made the editor unusable.
 *
 * The application's default subtitle font is the managed family. `resolveFontIdentity` refuses that
 * family unless told the package is installed, and the parameter carrying that fact defaulted to
 * `false` while no production caller supplied it. So the default font resolved to nothing, the
 * preview request was never built, and the editor showed "subtitle preview unavailable" on every
 * real installation, permanently.
 *
 * Every existing font test passed because each one constructed `managedPackInstalled: true` by
 * hand — supplying the single input that makes the code work and that production never provided.
 * These tests therefore go through the PRODUCTION path: they set the bootstrap value native code
 * defines, and call `previewFace` the way the preview hook calls it.
 */

const stageBootstrap = (value) => {
  if (value === undefined) delete globalThis.__OSG_MANAGED_UI_FONT__;
  else globalThis.__OSG_MANAGED_UI_FONT__ = value;
};

afterEach(() => stageBootstrap(undefined));

/** Exactly how `useNativePreviewRequest` resolves the face — no extra arguments. */
const resolveAsTheEditorDoes = (fontFamily = DEFAULT_SUBTITLE_FONT_FAMILY) => previewFace({
  fontFamily,
  fontWeight: 400,
  platform: 'windows',
  isSystemFaceInstalled: () => true,
});

describe('the default subtitle font on a real installation', () => {
  it('resolves when native reports the managed package installed', () => {
    stageBootstrap(true);
    const face = resolveAsTheEditorDoes();
    expect(face, 'the default font must resolve, or the preview can never render').not.toBeNull();
    expect(face.family).toBe('Google Sans');
  });

  it('does not resolve when native reports the package absent', () => {
    stageBootstrap(false);
    expect(resolveAsTheEditorDoes()).toBeNull();
  });

  it('a system font resolves regardless of the managed package', () => {
    stageBootstrap(false);
    expect(resolveAsTheEditorDoes('Arial, sans-serif')).not.toBeNull();
  });
});

describe('the capability snapshot distinguishes absent from not-yet-known', () => {
  it('reports pending when native has not spoken', () => {
    stageBootstrap(undefined);
    const snapshot = fontCapabilitySnapshot(globalThis);
    expect(snapshot.managedPack).toBe(MANAGED_PACK_STATE.unknown);
    expect(snapshot.pending).toBe(true);
    // Deliberately NOT true: unknown must never be reported as installed.
    expect(snapshot.managedPackInstalled).toBe(false);
  });

  it('reports absent only when native positively said so', () => {
    stageBootstrap(false);
    const snapshot = fontCapabilitySnapshot(globalThis);
    expect(snapshot.managedPack).toBe(MANAGED_PACK_STATE.absent);
    expect(snapshot.pending).toBe(false);
  });

  it('reports installed only for a literal true', () => {
    for (const value of ['true', 1, {}, []]) {
      stageBootstrap(value);
      expect(fontCapabilitySnapshot(globalThis).managedPackInstalled).toBe(false);
    }
  });
});

describe('the default font is shared, not repeated', () => {
  /**
   * The leaf names the family as a string, because a leaf with imports would be a cycle. That makes
   * drift possible, so it is asserted rather than trusted: rename the managed package and this fails
   * instead of the default quietly becoming unresolvable again.
   */
  it('names exactly the family the managed package declares', () => {
    expect(DEFAULT_SUBTITLE_FONT_NAME).toBe(MANAGED_FONT_PACKAGE.family);
  });

  it('is the same value the render customization defaults use', () => {
    expect(defaultSubtitleCustomization.fontFamily).toBe(DEFAULT_SUBTITLE_FONT_FAMILY);
  });

  /**
   * The property that matters, stated as behaviour rather than as string equality: whatever the two
   * defaults are, they must resolve to the SAME face, or an export silently disagrees with the
   * preview that authorised it.
   */
  it('resolves to one face for both the editor and the export', () => {
    stageBootstrap(true);
    const fromEditorDefault = resolveAsTheEditorDoes(DEFAULT_SUBTITLE_FONT_FAMILY);
    const fromCustomizationDefault = resolveAsTheEditorDoes(defaultSubtitleCustomization.fontFamily);
    expect(fromEditorDefault).not.toBeNull();
    expect(fromCustomizationDefault).toEqual(fromEditorDefault);
  });
});

describe('omitting the capability is a fault, not an answer', () => {
  /**
   * The shape of the original defect, guarded directly at the resolver.
   *
   * `managedPackInstalled` defaulted to `false`, so "the caller forgot" and "the package is missing"
   * produced the same refusal. That is why the bug survived: the failure looked like a legitimate
   * capability result on every machine, including the ones where the package was installed.
   */
  it('reports a distinct reason when the caller never said', () => {
    const resolved = resolveFontIdentity({
      fontFamily: DEFAULT_SUBTITLE_FONT_FAMILY,
      fontWeight: 400,
      platform: 'windows',
    });
    expect(resolved.status).toBe('unavailable');
    expect(resolved.reason).toBe(UNAVAILABLE_REASON.managedPackUnknown);
    expect(resolved.reason).not.toBe(UNAVAILABLE_REASON.managedPackUnavailable);
  });

  it('still reports a genuine absence as an absence', () => {
    const resolved = resolveFontIdentity({
      fontFamily: DEFAULT_SUBTITLE_FONT_FAMILY,
      fontWeight: 400,
      platform: 'windows',
      managedPackInstalled: false,
    });
    expect(resolved.reason).toBe(UNAVAILABLE_REASON.managedPackUnavailable);
  });
});
