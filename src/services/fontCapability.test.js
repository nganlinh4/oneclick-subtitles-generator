import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SUBTITLE_FONT_FAMILY,
  DEFAULT_SUBTITLE_FONT_NAME,
  FONT_READINESS_CONTRACT_MISMATCH,
  FONT_READINESS_EVENT,
  FONT_READINESS_REFUSAL,
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

const retryableRefusals = new Set([
  FONT_READINESS_REFUSAL.noUsableSource,
  FONT_READINESS_REFUSAL.storeUnavailable,
  FONT_READINESS_REFUSAL.timedOut,
]);

const refusalRecord = (reason, extra = {}) => record(FONT_READINESS_STATE.refused, {
  reason,
  retryable: retryableRefusals.has(reason),
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
    globalThis.__OSG_FONT_READINESS__ = refusalRecord(FONT_READINESS_REFUSAL.noUsableSource);
  } else globalThis.__OSG_FONT_READINESS__ = value;
};

afterEach(() => stageBootstrap(undefined));

/** Exactly how the shipping canvas/export scene resolves the face — no extra arguments. */
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

  it('reports installed only for the exact reviewed ready record', () => {
    for (const value of ['ready', 1, {}, [], { schema: 1, state: 'ready' }]) {
      stageBootstrap(value);
      expect(fontCapabilitySnapshot(globalThis).managedPackInstalled).toBe(false);
    }
    stageBootstrap(record(FONT_READINESS_STATE.ready));
    expect(fontCapabilitySnapshot(globalThis)).toMatchObject({
      managedPack: MANAGED_PACK_STATE.installed,
      managedPackInstalled: true,
      managedFamily: MANAGED_FONT_PACKAGE.family,
      managedVersion: MANAGED_FONT_PACKAGE.version,
      installedVersion: MANAGED_FONT_PACKAGE.version,
    });
  });

  it.each([
    ['newer schema', { schema: FONT_READINESS_SCHEMA + 1 }],
    ['wrong family', { family: 'Definitely Not Google Sans' }],
    ['missing version', { version: null }],
    ['wrong version', { version: 'v999-unreviewed' }],
    ['ready reason', { reason: FONT_READINESS_REFUSAL.integrityFailed }],
    ['ready retry', { retryable: true }],
    ['fractional epoch', { epoch: 1.5 }],
    ['extra field', { surprise: true }],
  ])('turns a present incompatible ready record into a bounded refusal: %s', (_label, patch) => {
    stageBootstrap(record(FONT_READINESS_STATE.ready, patch));
    expect(fontCapabilitySnapshot(globalThis)).toMatchObject({
      managedPack: MANAGED_PACK_STATE.absent,
      managedPackInstalled: false,
      pending: false,
      published: true,
      readiness: FONT_READINESS_STATE.refused,
      reason: FONT_READINESS_CONTRACT_MISMATCH,
      retryable: false,
      installedVersion: null,
    });
  });

  it('preserves a contradictory reported identity without treating it as the managed package', () => {
    stageBootstrap(record(FONT_READINESS_STATE.ready, {
      family: 'Definitely Not Google Sans',
      version: 'v999-unreviewed',
    }));
    expect(fontCapabilitySnapshot(globalThis)).toMatchObject({
      expectedManagedFamily: MANAGED_FONT_PACKAGE.family,
      expectedManagedVersion: MANAGED_FONT_PACKAGE.version,
      managedFamily: null,
      managedVersion: null,
      reportedFamily: 'Definitely Not Google Sans',
      reportedVersion: 'v999-unreviewed',
      managedPackInstalled: false,
    });
  });

  it('reports repairing as pending, because work is still happening', () => {
    stageBootstrap(record(FONT_READINESS_STATE.repairing));
    const snapshot = fontCapabilitySnapshot(globalThis);
    expect(snapshot.pending).toBe(true);
    expect(snapshot.readiness).toBe(FONT_READINESS_STATE.repairing);
    expect(snapshot.managedPack).toBe(MANAGED_PACK_STATE.unknown);
  });

  it('carries the typed reason and whether a retry is worth offering', () => {
    stageBootstrap(refusalRecord(FONT_READINESS_REFUSAL.integrityFailed));
    const snapshot = fontCapabilitySnapshot(globalThis);
    expect(snapshot.reason).toBe(FONT_READINESS_REFUSAL.integrityFailed);
    expect(snapshot.retryable).toBe(false);

    stageBootstrap(refusalRecord(FONT_READINESS_REFUSAL.noUsableSource));
    expect(fontCapabilitySnapshot(globalThis).retryable).toBe(true);
  });

  it.each([
    ['resolving with a version', FONT_READINESS_STATE.resolving, { version: MANAGED_FONT_PACKAGE.version }],
    ['repairing with a reason', FONT_READINESS_STATE.repairing, { reason: FONT_READINESS_REFUSAL.timedOut }],
    ['repairing marked retryable', FONT_READINESS_STATE.repairing, { retryable: true }],
    ['refused with a version', FONT_READINESS_STATE.refused, {
      version: MANAGED_FONT_PACKAGE.version,
      reason: FONT_READINESS_REFUSAL.integrityFailed,
    }],
    ['refused without a reason', FONT_READINESS_STATE.refused, {}],
    ['refused with an unknown reason', FONT_READINESS_STATE.refused, { reason: 'surprise' }],
    ['refused with wrong retry policy', FONT_READINESS_STATE.refused, {
      reason: FONT_READINESS_REFUSAL.noUsableSource,
      retryable: false,
    }],
  ])('rejects contradictory state-dependent fields: %s', (_label, state, patch) => {
    stageBootstrap(record(state, patch));
    expect(fontCapabilitySnapshot(globalThis)).toMatchObject({
      published: true,
      pending: false,
      managedPackInstalled: false,
      readiness: FONT_READINESS_STATE.refused,
      reason: FONT_READINESS_CONTRACT_MISMATCH,
    });
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

  it('rejects stale, duplicate, and malformed publications without regressing the authority', () => {
    stageBootstrap(record(FONT_READINESS_STATE.ready, { epoch: 5 }));
    const seen = [];
    const stop = subscribeToFontReadiness((snapshot) => seen.push(snapshot), {
      globalScope: globalThis,
    });

    for (const detail of [
      record(FONT_READINESS_STATE.repairing, { epoch: 4 }),
      record(FONT_READINESS_STATE.ready, { epoch: 5 }),
      { schema: FONT_READINESS_SCHEMA, epoch: 6, state: FONT_READINESS_STATE.ready },
    ]) {
      globalThis.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, { detail }));
    }
    expect(seen).toEqual([]);
    expect(fontCapabilitySnapshot(globalThis)).toMatchObject({
      readiness: FONT_READINESS_STATE.ready,
      epoch: 5,
      managedPackInstalled: true,
    });

    globalThis.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, {
      detail: record(FONT_READINESS_STATE.repairing, { epoch: 6 }),
    }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ readiness: FONT_READINESS_STATE.repairing, epoch: 6 });
    stop();
  });

  it('restores the accepted record when native assigned a rejected publication before announcing it', () => {
    stageBootstrap(record(FONT_READINESS_STATE.ready, { epoch: 5 }));
    const seen = [];
    const stop = subscribeToFontReadiness((snapshot) => seen.push(snapshot), {
      globalScope: globalThis,
    });

    for (const detail of [
      record(FONT_READINESS_STATE.repairing, { epoch: 4 }),
      record(FONT_READINESS_STATE.ready, { epoch: 5 }),
      { schema: FONT_READINESS_SCHEMA, epoch: 6, state: FONT_READINESS_STATE.ready },
    ]) {
      // This is the shipping order in `font_readiness_publish_script`: assignment first, event
      // second. Dispatching the payload alone cannot prove that the shared authority stayed put.
      globalThis.__OSG_FONT_READINESS__ = detail;
      globalThis.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, { detail }));
      expect(fontCapabilitySnapshot(globalThis)).toMatchObject({
        readiness: FONT_READINESS_STATE.ready,
        epoch: 5,
        managedPackInstalled: true,
      });
    }
    expect(seen).toEqual([]);

    const next = record(FONT_READINESS_STATE.repairing, { epoch: 6 });
    globalThis.__OSG_FONT_READINESS__ = next;
    globalThis.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, { detail: next }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ readiness: FONT_READINESS_STATE.repairing, epoch: 6 });
    stop();
  });

  it('delivers one valid native publication once to every subscriber', () => {
    stageBootstrap(record(FONT_READINESS_STATE.resolving, { epoch: 1 }));
    const first = [];
    const second = [];
    const stopFirst = subscribeToFontReadiness((snapshot) => first.push(snapshot.epoch), {
      globalScope: globalThis,
    });
    const stopSecond = subscribeToFontReadiness((snapshot) => second.push(snapshot.epoch), {
      globalScope: globalThis,
    });
    const next = record(FONT_READINESS_STATE.ready, { epoch: 2 });

    globalThis.__OSG_FONT_READINESS__ = next;
    globalThis.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, { detail: next }));
    globalThis.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, { detail: next }));

    expect(first).toEqual([2]);
    expect(second).toEqual([2]);
    stopFirst();
    stopSecond();
  });

  it('does not let a later malformed announcement overwrite a newer valid global record', () => {
    stageBootstrap(record(FONT_READINESS_STATE.resolving, { epoch: 2 }));
    const seen = [];
    const stop = subscribeToFontReadiness((snapshot) => seen.push(snapshot.epoch), {
      globalScope: globalThis,
    });
    globalThis.__OSG_FONT_READINESS__ = record(FONT_READINESS_STATE.ready, { epoch: 4 });

    globalThis.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, {
      detail: { schema: FONT_READINESS_SCHEMA, epoch: 3, state: 'not-a-state' },
    }));

    expect(seen).toEqual([4]);
    expect(fontCapabilitySnapshot(globalThis)).toMatchObject({
      epoch: 4, readiness: FONT_READINESS_STATE.ready, managedPackInstalled: true,
    });
    stop();
  });

  it('accepts a valid publication after an initially malformed value and still releases transport', async () => {
    stageBootstrap({ schema: FONT_READINESS_SCHEMA + 1 });
    let deliver = null;
    const unlisten = vi.fn();
    const listen = vi.fn((_event, listener) => {
      deliver = listener;
      return unlisten;
    });
    const seen = [];
    const stop = subscribeToFontReadiness((snapshot) => seen.push(snapshot), {
      globalScope: globalThis,
      listen,
    });
    await Promise.resolve();

    deliver({ payload: record(FONT_READINESS_STATE.ready, { epoch: 1 }) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ readiness: FONT_READINESS_STATE.ready, epoch: 1 });
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
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
  const catalogSource = readFileSync(
    resolve(__dirname, '..', '..', 'crates/osg-engine-packages/src/ui_font_catalog.rs'),
    'utf8',
  );
  const deliveryCatalog = JSON.parse(readFileSync(
    resolve(__dirname, '..', '..', 'crates/osg-engine-packages/delivery/ui-fonts.delivery.json'),
    'utf8',
  ));

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
      stageBootstrap(refusalRecord(reason));
      expect(fontCapabilitySnapshot(globalThis).reason).toBe(reason);
    }
  });

  it('agrees with native about which refusal reasons are retryable', () => {
    const retryableBody = nativeSource
      .split('const fn retryable(self) -> bool {')[1]
      ?.split(NEWLINE + '    }')[0] ?? '';
    const nativeRetryable = [...retryableBody.matchAll(/Self::([A-Z][A-Za-z]+)/g)]
      .map(([, variant]) => variant.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase())
      .sort();
    expect(nativeRetryable).toEqual([...retryableRefusals].sort());
  });

  it('agrees with native about the schema version and the event name', () => {
    expect(nativeSource).toContain(`FONT_READINESS_SCHEMA: u32 = ${FONT_READINESS_SCHEMA}`);
    expect(nativeSource).toContain(`FONT_READINESS_EVENT: &str = "${FONT_READINESS_EVENT}"`);
  });

  it('accepts exactly every field the camel-cased native record serializes', () => {
    const body = nativeSource
      .split('pub(crate) struct FontReadinessRecord {')[1]
      ?.split(NEWLINE + '}')[0] ?? '';
    const fields = [...body.matchAll(/^\s+pub ([a-z_]+):/gm)].map(([, field]) => (
      field.replace(/_([a-z])/g, (_whole, letter) => letter.toUpperCase())
    ));
    expect(fields).toEqual([
      'schema', 'epoch', 'state', 'family', 'version', 'reason', 'retryable',
    ]);
    expect(nativeSource.slice(0, nativeSource.indexOf(body)))
      .toContain('#[serde(rename_all = "camelCase")]');
  });

  it('serializes native epoch allocation with installation of the authoritative record', () => {
    const body = nativeSource
      .split('fn publish(&self, mut record: FontReadinessRecord) -> FontReadinessRecord {')[1]
      ?.split(NEWLINE + '    }')[0] ?? '';
    const lock = body.indexOf('let mut current = self.locked()');
    const epoch = body.indexOf('.checked_add(1)');
    const install = body.indexOf('*current = record');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(epoch).toBeGreaterThan(lock);
    expect(install).toBeGreaterThan(epoch);
  });

  it('binds the JS identity to the native family and compiled delivery catalog version', () => {
    expect(nativeSource).toContain(
      `MANAGED_SUBTITLE_FAMILY: &str = "${MANAGED_FONT_PACKAGE.family}"`,
    );
    expect(catalogSource).toContain(`const VERSION: &str = "${MANAGED_FONT_PACKAGE.version}"`);
    const versions = new Set(Object.values(deliveryCatalog.platforms)
      .flatMap(({ releases }) => releases.map(({ version }) => version)));
    expect([...versions]).toEqual([MANAGED_FONT_PACKAGE.version]);
  });
});
