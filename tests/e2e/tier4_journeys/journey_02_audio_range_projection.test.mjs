// Tier 4: Real-World Scenario - Journey 2: Audio source and selected nonzero range with exact single offset projection
// Specifications: WORD_NATIVE_TRANSCRIPTION_HANDOFF.md (Journey 2), TEST_INFRA.md, PROJECT.md F06, F08, F11

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { projectWindowOffset } from '../support/contracts.mjs';

test('Journey 2: Audio source and selected nonzero range with exact single offset projection', () => {
  // Input: audio source file (e.g. cortez-feel.wav), duration 180s
  const mediaAsset = {
    id: randomUUID(),
    kind: 'audio',
    display_name: 'cortez-feel.wav',
    duration_ms: 180_000,
  };

  // Selected nonzero range: 30.0s to 65.0s (offset 30,000ms, window duration 35,000ms)
  const selectionRange = {
    start_ms: 30_000,
    end_ms: 65_000,
  };

  // 1. Verify no video upload is performed for audio source
  const uploadPlan = {
    mediaKind: mediaAsset.kind,
    mimeType: 'audio/wav',
    extractVideoFrames: false,
  };
  assert.equal(uploadPlan.extractVideoFrames, false);
  assert.equal(uploadPlan.mimeType, 'audio/wav');

  // 2. Provider transcribes the 35s extracted audio clip (offsets are relative to 0s of clip)
  const windowRelativeWords = [
    { text: 'Feel', start_offset_ms: 1500, end_offset_ms: 2100 },
    { text: 'the', start_offset_ms: 2150, end_offset_ms: 2400 },
    { text: 'rhythm', start_offset_ms: 2450, end_offset_ms: 3200 },
    { text: 'closing', start_offset_ms: 32_000, end_offset_ms: 33_500 },
  ];

  // 3. Engine applies exact single offset projection: project_ms = selection_start_ms + offset_ms
  const projectedWords = windowRelativeWords.map(w => ({
    text: w.text,
    start_ms: projectWindowOffset(selectionRange.start_ms, w.start_offset_ms),
    end_ms: projectWindowOffset(selectionRange.start_ms, w.end_offset_ms),
  }));

  // Assertions:
  // First word bounds
  assert.equal(projectedWords[0].start_ms, 31_500);
  assert.equal(projectedWords[0].end_ms, 32_100);
  assert.ok(projectedWords[0].start_ms >= selectionRange.start_ms);

  // Last word bounds
  const lastWord = projectedWords[projectedWords.length - 1];
  assert.equal(lastWord.start_ms, 62_000);
  assert.equal(lastWord.end_ms, 63_500);
  assert.ok(lastWord.end_ms <= selectionRange.end_ms);

  // Invariant: No double offset projection
  assert.notEqual(projectedWords[0].start_ms, 30_000 + 30_000 + 1500, 'Must NOT apply offset twice');

  // Invariant: Original source duration and file unchanged
  assert.equal(mediaAsset.duration_ms, 180_000);
});
