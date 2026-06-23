import {
  getEngineDescriptor,
  getEngineType,
  isAsr,
  supportsTokenCounting,
  supportsLanguage,
  LOCAL_METHOD_IDS,
  buildMethodDescriptors,
} from './transcriptionEngineRegistry';

describe('transcriptionEngineRegistry', () => {
  test('gemini methods are type gemini: token counting, no segmentation/language', () => {
    for (const id of ['new', 'old']) {
      const d = getEngineDescriptor(id);
      expect(d.type).toBe('gemini');
      expect(d.optionsPanel).toBe('gemini');
      expect(supportsTokenCounting(id)).toBe(true);
      expect(supportsLanguage(id)).toBe(false);
      expect(isAsr(id)).toBe(false);
    }
  });

  test('parakeet is an asr engine without language, with the languages badge', () => {
    const d = getEngineDescriptor('nvidia-parakeet');
    expect(d.type).toBe('asr');
    expect(d.optionsPanel).toBe('asr');
    expect(d.route).toBe('parakeet');
    expect(supportsLanguage('nvidia-parakeet')).toBe(false);
    expect(supportsTokenCounting('nvidia-parakeet')).toBe(false);
    expect(d.supportedLanguagesBadges).toBeTruthy();
  });

  test('catalog ASR engines are derived (faster-whisper-turbo: language, route asr/<id>)', () => {
    const d = getEngineDescriptor('faster-whisper-turbo');
    expect(d.type).toBe('asr');
    expect(d.route).toBe('asr/faster-whisper-turbo');
    expect(supportsLanguage('faster-whisper-turbo')).toBe(true);
    expect(LOCAL_METHOD_IDS).toEqual(
      expect.arrayContaining(['nvidia-parakeet', 'faster-whisper-turbo'])
    );
  });

  test('buildMethodDescriptors computes availability from engineStatus + isVercelMode', () => {
    const engineStatus = { isReady: (id) => id === 'faster-whisper-turbo' };
    const list = buildMethodDescriptors(engineStatus, { isVercelMode: true });
    const byId = Object.fromEntries(list.map((d) => [d.id, d]));
    expect(byId.new.available).toBe(true);
    expect(byId.old.available).toBe(false); // disabled in Vercel mode
    expect(byId['nvidia-parakeet'].available).toBe(false); // engine not ready
    expect(byId['faster-whisper-turbo'].available).toBe(true); // engine ready
  });

  test('getEngineType defaults to gemini for an unknown method', () => {
    expect(getEngineType('totally-unknown')).toBe('gemini');
  });
});
