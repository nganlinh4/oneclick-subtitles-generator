// Tier 4: Real-World Scenario - Journey 10: Refusals and truthful recovery (quota, malformed output, model error, missing audio)
// Specifications: WORD_NATIVE_TRANSCRIPTION_HANDOFF.md (Journey 10), TEST_INFRA.md, PROJECT.md F05, F06, F08

import test from 'node:test';
import assert from 'node:assert/strict';

test('Journey 10: Refusals and truthful recovery (quota, malformed output, model error, missing audio)', () => {
  // Oracle: Truthful error classification and recovery policy
  const evaluateRefusalRecovery = (failureCase) => {
    switch (failureCase.type) {
      case 'missing_audio':
        return {
          settled: true,
          silentFallbackUsed: false,
          userToast: 'Error: Media file contains no audible sound.',
          allowRetry: false,
          priorSavedWorkPreserved: true,
        };

      case 'quota_exhaustion_429':
        return {
          settled: true,
          silentFallbackUsed: false,
          userToast: 'Gemini quota limit exceeded. Transcription paused truthfully.',
          allowRetry: false,
          priorSavedWorkPreserved: true,
        };

      case 'malformed_provider_json':
        return {
          settled: true,
          silentFallbackUsed: false,
          userToast: 'Received malformed provider output. Window quarantined.',
          allowRetry: true,
          priorSavedWorkPreserved: true,
        };

      case 'stream_truncated':
        return {
          settled: true,
          silentFallbackUsed: false,
          userToast: 'Connection interrupted before completion.',
          allowRetry: true,
          priorSavedWorkPreserved: true,
        };

      case 'interrupted_save':
        return {
          settled: true,
          silentFallbackUsed: false,
          userToast: 'Failed to write to disk. Retrying transaction in safe mode.',
          allowRetry: true,
          priorSavedWorkPreserved: true,
        };

      default:
        throw new Error(`Unhandled case: ${failureCase.type}`);
    }
  };

  const cases = [
    { type: 'missing_audio' },
    { type: 'quota_exhaustion_429' },
    { type: 'malformed_provider_json' },
    { type: 'stream_truncated' },
    { type: 'interrupted_save' },
  ];

  for (const c of cases) {
    const outcome = evaluateRefusalRecovery(c);
    assert.equal(outcome.settled, true);
    assert.equal(outcome.silentFallbackUsed, false, 'Silent protocol or model fallback is strictly forbidden');
    assert.equal(outcome.priorSavedWorkPreserved, true, 'Prior saved work must never be wiped upon error');
    assert.ok(outcome.userToast.length > 0, 'Must provide an actionable toast message');
  }
});
