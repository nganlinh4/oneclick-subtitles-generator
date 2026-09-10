import { beforeEach, describe, expect, it } from 'vitest';
import {
  readProcessingMethod,
  readTranscribeOptions,
  writeProcessingMethod,
  writeTranscribeOptions,
} from './videoProcessingPreferences';

beforeEach(() => localStorage.clear());

describe('video processing preferences', () => {
  it('round-trips Live method and every method-specific option across a remount', () => {
    expect(writeProcessingMethod('gemini-transcribe-live')).toBe('gemini-transcribe-live');
    writeTranscribeOptions({
      windowDurationSecs: 240,
      languageHints: ['vi'],
      diarization: true,
    });

    expect(readProcessingMethod()).toBe('gemini-transcribe-live');
    expect(readTranscribeOptions()).toEqual({
      windowDurationSecs: 240,
      languageHints: ['vi'],
      diarization: true,
    });
  });

  it('contains corrupt and obsolete persisted values at the preference boundary', () => {
    localStorage.setItem('video_processing_method', 'removed-engine');
    localStorage.setItem('video_processing_transcribe_window_seconds', '999999');
    localStorage.setItem('video_processing_transcribe_language_hints', '{bad json');
    localStorage.setItem('video_processing_transcribe_diarization', 'maybe');

    expect(readProcessingMethod()).toBe('new');
    expect(readTranscribeOptions()).toEqual({
      windowDurationSecs: 600,
      languageHints: [],
      diarization: false,
    });
  });
});
