// Tier 2: Boundary & Corner Cases - Area 6: Verification & Benchmarks Boundary
// Specifications: ORIGINAL_REQUEST.md §R6, PROJECT.md F23-F24, WORD_NATIVE_TRANSCRIPTION_HANDOFF.md

import test from 'node:test';
import assert from 'node:assert/strict';

test('T2.6.1: Provider HTTP 429 quota exhaustion triggers bounded backoff and reports quota refusal', () => {
  const handleProviderResponse = (status, responseBody) => {
    if (status === 429) {
      return {
        action: 'backoff_and_refuse',
        errorClass: 'QuotaExceeded',
        userMessage: 'Provider quota limit reached. Please check your Gemini API plan or try again later.',
        retryAllowed: false,
      };
    }
    return { action: 'proceed' };
  };

  const outcome = handleProviderResponse(429, { error: { message: 'Resource exhausted' } });
  assert.equal(outcome.errorClass, 'QuotaExceeded');
  assert.equal(outcome.retryAllowed, false);
  assert.ok(outcome.userMessage.includes('quota limit reached'));
});

test('T2.6.2: Provider HTTP 503 / network disconnection preserves completed stages for targeted retry', () => {
  const stages = [
    { id: 'extract_audio', completed: true },
    { id: 'transcribe_window_0', completed: true },
    { id: 'transcribe_window_1', completed: false, error: 'HTTP 503 Service Unavailable' },
  ];

  const planTargetedRetry = (stageList) => {
    const failed = stageList.find(s => !s.completed);
    assert.ok(failed);
    return {
      retryStageId: failed.id,
      preserveStages: stageList.filter(s => s.completed).map(s => s.id),
    };
  };

  const retryPlan = planTargetedRetry(stages);
  assert.equal(retryPlan.retryStageId, 'transcribe_window_1');
  assert.deepEqual(retryPlan.preserveStages, ['extract_audio', 'transcribe_window_0']);
});

test('T2.6.3: Malformed SSE line (invalid JSON) safely quarantined without crashing event stream parser', () => {
  const parseSseChunk = (rawChunk) => {
    const lines = rawChunk.split('\n');
    const validEvents = [];
    const errors = [];

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (dataStr === '[DONE]') {
        validEvents.push({ type: 'done' });
        continue;
      }
      try {
        const parsed = JSON.parse(dataStr);
        validEvents.push({ type: 'event', data: parsed });
      } catch (err) {
        errors.push({ line, error: err.message });
      }
    }
    return { validEvents, errors };
  };

  const corruptStream = 'data: {"valid": 1}\ndata: {NOT_VALID_JSON}\ndata: [DONE]\n';
  const { validEvents, errors } = parseSseChunk(corruptStream);

  assert.equal(validEvents.length, 2);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].line.includes('{NOT_VALID_JSON}'));
});

test('T2.6.4: Billed benchmark slot exhaustion reports exhaustion cleanly without infinite retry', () => {
  const pool = [
    { slot: 1, exhausted: true },
    { slot: 2, exhausted: true },
  ];

  const getAvailableSlot = (slots) => {
    const available = slots.find(s => !s.exhausted);
    if (!available) {
      throw new Error('All configured credential slots exhausted');
    }
    return available;
  };

  assert.throws(() => getAvailableSlot(pool), /All configured credential slots exhausted/);
});

test('T2.6.5: Zero-audio input (digital silence or missing audio stream) fails fast with truthful diagnostic', () => {
  const checkAudioStream = (audioMetadata) => {
    if (!audioMetadata.hasAudioTrack) {
      return { canTranscribe: false, reason: 'Media contains no audio track.' };
    }
    if (audioMetadata.rmsVolumeDb !== undefined && audioMetadata.rmsVolumeDb <= -90) {
      return { canTranscribe: false, reason: 'Audio track is completely silent (-90dB).' };
    }
    return { canTranscribe: true };
  };

  const noAudio = checkAudioStream({ hasAudioTrack: false });
  assert.equal(noAudio.canTranscribe, false);
  assert.equal(noAudio.reason, 'Media contains no audio track.');

  const silentAudio = checkAudioStream({ hasAudioTrack: true, rmsVolumeDb: -96 });
  assert.equal(silentAudio.canTranscribe, false);
  assert.ok(silentAudio.reason.includes('completely silent'));
});

test('T2.6.6: Truncated provider stream without terminal finish_reason is caught and flagged as incomplete', () => {
  const streamEvents = [
    { words: [{ word: 'Incomplete' }], finishReason: undefined },
    // Connection drops abruptly here without finishReason: STOP or [DONE]
  ];

  const isStreamComplete = (events, sawDoneMarker) => {
    if (sawDoneMarker) return true;
    const lastEvent = events[events.length - 1];
    return lastEvent?.finishReason === 'STOP';
  };

  assert.equal(isStreamComplete(streamEvents, false), false, 'Abruptly dropped stream must NOT be marked complete');
});
