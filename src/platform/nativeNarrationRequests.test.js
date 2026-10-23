import { createNativeSpeechProfile } from './nativeNarrationRequests';

const JOB_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a1';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

describe('legacy-to-native speech settings', () => {
  test('converts F5, Chatterbox, Edge, and gTTS controls without path or process options', () => {
    expect(createNativeSpeechProfile('f5tts', {
      language: 'en-US',
      speechRate: 1.25,
      nfeStep: 16,
      swayCoef: -0.5,
      cfgStrength: 2.5,
      removeSilence: false,
    })).toMatchObject({
      backend: 'f5Tts',
      speechRateMilli: 1_250,
      nfeSteps: 16,
      swayMilli: -500,
      guidanceMilli: 2_500,
      removeSilence: false,
    });
    expect(() => createNativeSpeechProfile('f5tts', { language: 'ko' })).toThrow('invalid');
    expect(() => createNativeSpeechProfile('f5tts', { language: 'unknown' })).toThrow('invalid');
    expect(createNativeSpeechProfile('chatterbox', {
      lang: 'ko',
      exaggeration: 1.2,
      cfgWeight: 0.4,
    })).toMatchObject({
      backend: 'chatterbox',
      language: 'ko',
      exaggerationMilli: 1_200,
      cfgWeightMilli: 400,
    });
    expect(createNativeSpeechProfile('edge-tts', {
      voice: 'en-US-AriaNeural',
      rate: '+15%',
      volume: '-4%',
      pitch: '+8Hz',
    })).toMatchObject({ ratePercent: 15, volumePercent: -4, pitchHz: 8 });
    expect(createNativeSpeechProfile('gtts', {
      lang: 'en',
      tld: 'co.uk',
      slow: true,
    })).toEqual({
      backend: 'gtts',
      language: 'en',
      domain: 'co.uk',
      slow: true,
    });
  });

  test('Gemini requires a unique credential pool and rejects browser-held keys', () => {
    expect(createNativeSpeechProfile('gemini', {
      credentialIds: [JOB_ID],
      voice: 'Kore',
    })).toMatchObject({ backend: 'geminiTts', credentialIds: [JOB_ID], voice: 'Kore' });
    expect(() => createNativeSpeechProfile('gemini', {
      credentialIds: [JOB_ID],
      apiKey: 'browser-secret',
    })).toThrow('invalid');
    expect(() => createNativeSpeechProfile('gemini', {
      credentialIds: [JOB_ID, JOB_ID],
    })).toThrow('invalid');
  });

  test('all backends reject secret, path, and process controls at the adapter boundary', () => {
    expect(() => createNativeSpeechProfile('f5tts', {
      gemini_api_key: 'browser-secret',
    })).toThrow('invalid');
    expect(() => createNativeSpeechProfile('chatterbox', {
      referencePath: 'C:/private/reference.wav',
    })).toThrow('invalid');
    expect(() => createNativeSpeechProfile('edge-tts', {
      voice: 'en-US-AriaNeural',
      serverUrl: 'http://127.0.0.1:9999',
    })).toThrow('invalid');
    expect(() => createNativeSpeechProfile('gtts', {
      lang: 'en',
      pythonPath: 'C:/Python/python.exe',
    })).toThrow('invalid');
  });
});
