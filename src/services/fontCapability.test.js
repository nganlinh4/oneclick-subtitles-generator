import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SUBTITLE_FONT_FAMILY,
  DEFAULT_SUBTITLE_FONT_NAME,
  FONT_READINESS_EVENT,
  FONT_READINESS_SCHEMA,
  FONT_READINESS_STATE,
  MANAGED_PACK_STATE,
  fontCapabilitySnapshot,
  subscribeToFontReadiness,
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

/** A readiness record shaped exactly as native publishes it. */
const record = (state, extra = {}) => ({
  schema: FONT_READINESS_SCHEMA,
  epoch: 1,
  state,
  family: 'Google Sans',
  version: state === FONT_READINESS_STATE.ready ? 'v22-ui4' : null,
  reason: null,
  retryable: false,
  ...extra,
});

/**
 * Stage what native published.
 *
 * `true`/`false` are accepted as shorthand for the two outcomes so the tests read as statements
 * about the product rather than about the record shape.
 */
const stageBootstrap = (value) => {
  if (value === undefined) {
    delete globalThis.__OSG_FONT_READINESS__;
    return;
  }
  if (value === true) globalThis.__OSG_FONT_READINESS__ = record(FONT_READINESS_STATE.ready);
  else if (value === false) {
    globalThis.__OSG_FONT_READINESS__ = record(FONT_READINESS_STATE.refused, {
      reason: 'no-usable-source',
      retryable: true,
    });
  } else globalThis.__OSG_FONT_READINESS__ = value;
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

  it('reports installed only for a record that says ready', () => {
    for (const value of ['ready', 1, {}, [], { schema: 1, state: 'ready' }]) {
      stageBootstrap(value);
      expect(fontCapabilitySnapshot(globalThis).managedPackInstalled).toBe(false);
    }
  });

  it('treats a record from a newer schema as unknown rather than guessing at it', () => {
    stageBootstrap(record(FONT_READINESS_STATE.ready, { schema: FONT_READINESS_SCHEMA + 1 }));
    const snapshot = fontCapabilitySnapshot(globalThis);
    expect(snapshot.managedPack).toBe(MANAGED_PACK_STATE.unknown);
    expect(snapshot.managedPackInstalled).toBe(false);
  });

  it('reports repairing as pending, because work is still happening', () => {
    stageBootstrap(record(FONT_READINESS_STATE.repairing));
    const snapshot = fontCapabilitySnapshot(globalThis);
    expect(snapshot.pending).toBe(true);
    expect(snapshot.readiness).toBe(FONT_READINESS_STATE.repairing);
    expect(snapshot.managedPack).toBe(MANAGED_PACK_STATE.unknown);
  });

  it('carries the typed reason and whether a retry is worth offering', () => {
    stageBootstrap(record(FONT_READINESS_STATE.refused, {
      reason: 'integrity-failed',
      retryable: false,
    }));
    const snapshot = fontCapabilitySnapshot(globalThis);
    expect(snapshot.reason).toBe('integrity-failed');
    expect(snapshot.retryable).toBe(false);

    stageBootstrap(record(FONT_READINESS_STATE.refused, {
      reason: 'no-usable-source',
      retryable: true,
    }));
    expect(fontCapabilitySnapshot(globalThis).retryable).toBe(true);
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

describe('a repair that lands after startup', () => {
  /**
   * The defect this whole mechanism exists for.
   *
   * Native waits a bounded time for the font. When that wait expires the installation keeps going
   * and can finish moments later. The old bootstrap froze a boolean, so the editor could never be
   * told, and it waited for a preview that would never arrive.
   */
  it('turns an unusable font into a usable one within the same session', () => {
    stageBootstrap(record(FONT_READINESS_STATE.refused, {
      reason: 'timed-out',
      retryable: true,
      epoch: 4,
    }));
    expect(resolveAsTheEditorDoes()).toBeNull();

    const seen = [];
    const stop = subscribeToFontReadiness((snapshot) => seen.push(snapshot), {
      globalScope: globalThis,
    });

    globalThis.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, {
      detail: record(FONT_READINESS_STATE.ready, { epoch: 5 }),
    }));
    stop();

    expect(seen).toHaveLength(1);
    expect(seen[0].managedPackInstalled).toBe(true);
    expect(seen[0].epoch).toBe(5);
    expect(resolveAsTheEditorDoes()).not.toBeNull();
  });

  it('advances the epoch so a consumer can discard a stale answer', () => {
    stageBootstrap(record(FONT_READINESS_STATE.resolving, { epoch: 1 }));
    const seen = [];
    const stop = subscribeToFontReadiness((snapshot) => seen.push(snapshot.epoch), {
      globalScope: globalThis,
    });

    for (const epoch of [2, 3]) {
      globalThis.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, {
        detail: record(FONT_READINESS_STATE.repairing, { epoch }),
      }));
    }
    stop();

    expect(seen).toEqual([2, 3]);
  });

  it('stops listening once released, so a superseded surface cannot be woken', () => {
    stageBootstrap(record(FONT_READINESS_STATE.resolving));
    const seen = [];
    const stop = subscribeToFontReadiness(() => seen.push(true), { globalScope: globalThis });
    stop();

    globalThis.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, {
      detail: record(FONT_READINESS_STATE.ready),
    }));

    expect(seen).toHaveLength(0);
  });
});

const NEWLINE = String.fromCharCode(10);

describe('the readiness contract matches the native definition', () => {
  /**
   * Both sides of an IPC boundary describing the same enum is a contract, and a contract nobody
   * checks is a comment. The native source is read directly rather than duplicated into a fixture,
   * so renaming a variant in Rust fails here instead of silently producing a state the frontend
   * treats as unknown -- which would report the font unavailable for a reason nobody could see.
   */
  const nativeSource = readFileSync(
    resolve(__dirname, '..', '..', 'apps/desktop/src-tauri/src/font_readiness.rs'),
    'utf8',
  );

  /** Rust variants under a `kebab-case` rename, as serde will emit them. */
  const variantsOf = (enumName) => {
    const body = nativeSource.split(`enum ${enumName} {`)[1]?.split(NEWLINE + '}')[0] ?? '';
    return body
      .split(NEWLINE)
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Za-z]*,$/.test(line))
      .map((line) => line.slice(0, -1).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase());
  };

  it('declares exactly the states native can publish', () => {
    expect(variantsOf('FontState').sort()).toEqual(Object.values(FONT_READINESS_STATE).sort());
  });

  it('understands every refusal reason native can send', () => {
    const reasons = variantsOf('FontRefusal');
    expect(reasons.length).toBeGreaterThan(0);
    // Each must survive a round trip through the snapshot rather than being dropped as malformed.
    for (const reason of reasons) {
      stageBootstrap(record(FONT_READINESS_STATE.refused, { reason }));
      expect(fontCapabilitySnapshot(globalThis).reason).toBe(reason);
    }
  });

  it('agrees with native about the schema version and the event name', () => {
    expect(nativeSource).toContain(`FONT_READINESS_SCHEMA: u32 = ${FONT_READINESS_SCHEMA}`);
    expect(nativeSource).toContain(`FONT_READINESS_EVENT: &str = "${FONT_READINESS_EVENT}"`);
  });
});
