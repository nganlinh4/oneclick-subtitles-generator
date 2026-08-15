import { describe, expect, it } from 'vitest';

import { defaultCustomization } from '../components/subtitleCustomization/defaultCustomization';
import {
  DURATION_SOURCE,
  PARITY_DISPOSITIONS,
  RENDER_OUTPUT_PARITY_LEDGER,
  RENDER_PARITY_LEDGER,
  allDeliberateChanges,
  deliberatelyChangedFields,
  pendingOutputParityFields,
  pendingParityFields,
} from './renderParityLedger';

describe('render parity ledger', () => {
  it('accounts for every persisted customization field, and invents none', () => {
    // The whole point of the ledger. Adding a field to the schema without deciding what the native
    // renderer does with it fails here, rather than shipping a setting that silently stops working.
    const schemaFields = Object.keys(defaultCustomization).sort();
    const ledgerFields = Object.keys(RENDER_PARITY_LEDGER).sort();

    const missing = schemaFields.filter(field => !ledgerFields.includes(field));
    const extra = ledgerFields.filter(field => !schemaFields.includes(field));

    expect(missing, 'customization fields with no parity decision').toEqual([]);
    expect(extra, 'ledger entries for fields that no longer exist').toEqual([]);
  });

  it('covers the field count the migration was scoped against', () => {
    // The design doc scoped this work at 54 subtitle-customization fields. If that number moves,
    // the scope moved with it and the doc needs revisiting.
    expect(Object.keys(RENDER_PARITY_LEDGER)).toHaveLength(54);
  });

  it('gives every field a recognised disposition', () => {
    for (const [field, record] of Object.entries(RENDER_PARITY_LEDGER)) {
      expect(PARITY_DISPOSITIONS, `${field} disposition`).toContain(record.disposition);
    }
  });

  it('makes an implemented field say where it is implemented', () => {
    for (const [field, record] of Object.entries(RENDER_PARITY_LEDGER)) {
      if (record.disposition === 'native' || record.disposition === 'fixed') {
        expect(record.where, `${field} must name its implementation`).toBeTruthy();
      }
    }
  });

  it('makes a deliberate behaviour change explain itself', () => {
    // A `fixed` field is the only disposition that can alter how an existing project looks, so it
    // is the only one that owes the user an explanation in the release notes.
    for (const field of deliberatelyChangedFields()) {
      expect(RENDER_PARITY_LEDGER[field].note, `${field} must say what changes`).toBeTruthy();
    }
  });

  it('never leaves a pending field claiming an implementation', () => {
    for (const field of pendingParityFields()) {
      expect(RENDER_PARITY_LEDGER[field].where, `${field} is pending`).toBeNull();
    }
  });

  it('reports the remaining work honestly rather than rounding it down', () => {
    // Deliberately asserts the real current number. This test failing because the count dropped is
    // the migration making progress; update it, do not delete it. It reaches zero at the end.
    const pending = pendingParityFields();
    expect(pending).toHaveLength(26);
    expect(pending).toContain('strokeEnabled');
    expect(pending).toContain('glowEnabled');
    expect(pending).toContain('borderRadius');
  });

  it('keeps the inert fields inert so saved projects still round-trip', () => {
    // These ten are validated and persisted end to end but have never rendered anything. Removing
    // them would break existing project files; implementing them would change existing projects'
    // appearance. Both are decisions, and neither is one to make by accident.
    const inert = Object.keys(RENDER_PARITY_LEDGER)
      .filter(field => RENDER_PARITY_LEDGER[field].disposition === 'inert')
      .sort();

    expect(inert).toEqual([
      'gradientColorMid',
      'gradientType',
      'lineBreakBehavior',
      'maxLines',
      'multiShadowEnabled',
      'pulseEnabled',
      'pulseSpeed',
      'shadowLayers',
      'shakeEnabled',
      'shakeIntensity',
    ]);

    // Every inert field must still survive a save/load round trip untouched.
    for (const field of inert) {
      expect(defaultCustomization, `${field} must stay in the schema`).toHaveProperty(field);
    }
  });
});

describe('render output parity ledger', () => {
  it('covers the render and crop settings the native contract actually carries', () => {
    // 54 subtitle fields plus these 16 are the 70 persisted options the migration was scoped
    // against. Keeping both halves asserted means neither can drift without a failing test.
    expect(Object.keys(RENDER_OUTPUT_PARITY_LEDGER)).toHaveLength(16);
    expect(
      Object.keys(RENDER_PARITY_LEDGER).length + Object.keys(RENDER_OUTPUT_PARITY_LEDGER).length,
    ).toBe(70);
  });

  it('names every render setting the native request normalizes', () => {
    for (const field of [
      'resolution', 'frameRate', 'originalAudioVolume', 'narrationVolume', 'trimStart', 'trimEnd',
    ]) {
      expect(RENDER_OUTPUT_PARITY_LEDGER, field).toHaveProperty(field);
    }
  });

  it('names every crop setting the native request normalizes', () => {
    for (const field of [
      'x', 'y', 'width', 'height', 'aspectRatio',
      'canvasBgMode', 'canvasBgColor', 'canvasBgBlur', 'flipX', 'flipY',
    ]) {
      expect(RENDER_OUTPUT_PARITY_LEDGER, field).toHaveProperty(field);
    }
  });

  it('gives every output setting a recognised disposition and an honest implementation claim', () => {
    for (const [field, record] of Object.entries(RENDER_OUTPUT_PARITY_LEDGER)) {
      expect(PARITY_DISPOSITIONS, `${field} disposition`).toContain(record.disposition);
      if (record.disposition === 'pending') {
        expect(record.where, `${field} is pending`).toBeNull();
      } else {
        expect(record.where, `${field} must name its implementation`).toBeTruthy();
      }
    }
  });

  it('treats the trim and crop defects as changes a user will see, not as silent repairs', () => {
    // Both of these alter files a user has already exported once. Fixing them quietly would look
    // like the migration broke something, so each has to explain itself well enough to write a
    // release note from.
    const changes = allDeliberateChanges();
    const fields = changes.map(change => change.field);

    expect(fields).toContain('trimStart');
    expect(fields).toContain('x');
    expect(fields).toContain('backgroundOpacity');

    for (const change of changes) {
      expect(change.note, `${change.field} must say what changes`).toBeTruthy();
      expect(change.where, `${change.field} must name its implementation`).toBeTruthy();
    }

    // The two that move pixels in an already-exported file shout about it; the colour one is
    // explicitly pixel-identical and only makes a silent failure findable.
    expect(RENDER_OUTPUT_PARITY_LEDGER.trimStart.note).toContain('VISIBLE CHANGE');
    expect(RENDER_OUTPUT_PARITY_LEDGER.x.note).toContain('VISIBLE CHANGE');
    expect(RENDER_PARITY_LEDGER.backgroundOpacity.note).toContain('Unchanged on screen');
  });

  it('takes the export duration from the timeline rather than from however extraction went', () => {
    expect(DURATION_SOURCE.native).toBe('the scene timeline frame count');
    expect(DURATION_SOURCE.shipped).toContain('overriding the computed duration');
    expect(DURATION_SOURCE.where).toBeTruthy();
  });

  it('reports the remaining output work honestly', () => {
    // 16 output settings, of which the timeline covers one and five are deliberate defect fixes.
    expect(pendingOutputParityFields()).toHaveLength(10);
    expect(pendingParityFields().length + pendingOutputParityFields().length).toBe(36);
  });
});
