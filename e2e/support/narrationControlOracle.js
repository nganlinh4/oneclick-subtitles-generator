import { strict as assert } from 'node:assert';

/**
 * Pure oracles for the per-cue narration control surface: regenerating exactly one cue's narration
 * and playing back an already-generated cue. These complement narrationJourneyOracle.js, which owns
 * the full-batch generation, alignment and export proofs -- this module owns the narrower single-cue
 * ownership claim a regenerate control makes: "only this one line changes."
 */

/** English copy of the disabled tooltip narrationMethodSelectionMaterial's HelpIcon renders for a
 * reference-voice-cloning method (F5-TTS/Chatterbox) while its engine package is not installed and
 * running. Shared with GenerateButton.js/GTTSNarrationSection.js/AsrProcessingOptions.js under the
 * same `narration.engineUnavailableMessage` i18n key. GROUND TRUTH: every call site's own hardcoded
 * i18next fallback string reads "...Settings > Tools." (plain greater-than), but
 * src/i18n/locales/en/narration.json's loaded `engineUnavailableMessage` resource -- which i18next
 * always prefers over a call site's fallback default when the key exists -- reads "...Settings →
 * Tools." (U+2192 RIGHTWARDS ARROW). The customer-visible copy is the loaded resource, not the
 * in-code fallback, so this pins the resource's exact text. */
export const REFERENCE_VOICE_ENGINE_UNAVAILABLE_MESSAGE = (
  'This narration engine could not be prepared automatically. Try generating again.'
);

/**
 * SQLite hands identifiers back as lowercase hex (see database.js's `readable()`); the revision-owned
 * narration checkpoint stores them however the record was written, which can be a dashed UUID. Two
 * reads of the "same" artifact id can therefore differ only in formatting -- compare by value, not by
 * exact string, the same way narrationJourneyOracle.js's private `identifier()` helper does.
 */
const normalizeId = (value) => String(value ?? '').replaceAll('-', '').toLowerCase();

/**
 * Prove that regenerating ONE cue preserves one valid checkpoint entry for that cue while every
 * other cue still names its pre-existing artifact. A content-addressed store may legitimately
 * reuse the target's prior artifact when a deterministic provider returns byte-identical audio;
 * the journey separately proves that a new synthesis job actually ran and succeeded.
 *
 * `beforeResults`/`afterResults` are the exact `results` arrays narrationJourneyOracle.js's
 * `durableProjectNarrations` decodes from the `projectNarration` checkpoint row, keyed by the
 * durable cue ordinal (`outputIndex`) the same way `verifyNarrationGenerationOwnership` does.
 */
export const verifyPerCueRegenerationOwnership = ({
  beforeResults,
  afterResults,
  regeneratedOrdinal,
}) => {
  assert.ok(Number.isSafeInteger(regeneratedOrdinal), 'regenerated cue ordinal must be an integer');
  assert.equal(
    afterResults.length,
    beforeResults.length,
    'regenerating one cue changed the total number of durable narration results',
  );

  const beforeByOrdinal = new Map(beforeResults.map((result) => [Number(result.outputIndex), result]));
  const afterByOrdinal = new Map(afterResults.map((result) => [Number(result.outputIndex), result]));
  assert.deepEqual(
    [...afterByOrdinal.keys()].sort((left, right) => left - right),
    [...beforeByOrdinal.keys()].sort((left, right) => left - right),
    'regenerating one cue changed which cues own a narration result',
  );
  assert.ok(beforeByOrdinal.has(regeneratedOrdinal), `no prior narration result exists for cue ${regeneratedOrdinal}`);

  let regeneratedArtifactId = null;
  let deduplicated = null;
  for (const [ordinal, before] of beforeByOrdinal) {
    const after = afterByOrdinal.get(ordinal);
    assert.ok(after, `cue ${ordinal} lost its narration result after an unrelated cue was regenerated`);
    if (ordinal === regeneratedOrdinal) {
      assert.ok(normalizeId(after.artifactId), `cue ${ordinal} lost its narration artifact`);
      assert.equal(after.text, before.text, `cue ${ordinal} narration text changed during regeneration`);
      assert.equal(after.startMicros, before.startMicros, `cue ${ordinal} start time changed during regeneration`);
      assert.equal(after.endMicros, before.endMicros, `cue ${ordinal} end time changed during regeneration`);
      regeneratedArtifactId = after.artifactId;
      deduplicated = normalizeId(after.artifactId) === normalizeId(before.artifactId);
    } else {
      assert.equal(
        normalizeId(after.artifactId),
        normalizeId(before.artifactId),
        `cue ${ordinal} was rebound to a different artifact even though only cue ${regeneratedOrdinal} was regenerated`,
      );
      assert.equal(
        after.text,
        before.text,
        `cue ${ordinal} narration text changed even though only cue ${regeneratedOrdinal} was regenerated`,
      );
      assert.equal(
        after.startMicros,
        before.startMicros,
        `cue ${ordinal} timing changed even though only cue ${regeneratedOrdinal} was regenerated`,
      );
    }
  }
  assert.equal(typeof regeneratedArtifactId, 'string', 'the regenerated cue has no durable artifact id');
  return Object.freeze({ regeneratedOrdinal, artifactId: regeneratedArtifactId, deduplicated, siblingOrdinals: Object.freeze(
    [...beforeByOrdinal.keys()].filter((ordinal) => ordinal !== regeneratedOrdinal).sort((left, right) => left - right),
  ) });
};

/**
 * Prove every untouched sibling artifact's bytes never changed while an unrelated cue regenerated.
 *
 * Each entry already carries an independently computed SHA-256 and size read from disk before and
 * after the regenerate; this function only enforces that nothing here silently skipped the compare.
 */
export const verifySiblingArtifactsUntouched = (siblings) => {
  assert.ok(Array.isArray(siblings) && siblings.length > 0, (
    'no sibling artifacts were captured to prove regeneration does not touch them'
  ));
  for (const sibling of siblings) {
    assert.ok(Number.isSafeInteger(sibling.ordinal), 'a sibling artifact record is missing its cue ordinal');
    assert.ok(sibling.beforeSha256 && sibling.afterSha256, `cue ${sibling.ordinal} is missing a captured hash`);
    assert.equal(
      sibling.afterSize,
      sibling.beforeSize,
      `cue ${sibling.ordinal}'s artifact size changed after an unrelated cue was regenerated`,
    );
    assert.equal(
      sibling.afterSha256,
      sibling.beforeSha256,
      `cue ${sibling.ordinal}'s artifact bytes changed after an unrelated cue was regenerated`,
    );
  }
  return Object.freeze({ untouchedOrdinals: Object.freeze(siblings.map(({ ordinal }) => ordinal)) });
};
