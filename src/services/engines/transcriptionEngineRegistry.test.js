import {
  getEngineDescriptor,
  getEngineType,
  isAsr,
  supportsTokenCounting,
  supportsLanguage,
  LOCAL_METHOD_IDS,
  DESCRIPTORS,
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

  test('Qwen advertises only the forced languages accepted by its native worker', () => {
    const qwen = getEngineDescriptor('qwen3-asr-0.6b');
    expect(qwen.supportedLanguageCodes).toEqual([
      'zh', 'en', 'fr', 'de', 'it', 'ja', 'ko', 'pt', 'ru', 'es',
    ]);
    expect(qwen.supportedLanguageCodes).not.toContain('vi');
    expect(getEngineDescriptor('faster-whisper-turbo').supportedLanguageCodes).toBeNull();
  });

  test('lists every method in dropdown order with no availability gate', () => {
    const ids = DESCRIPTORS.map((d) => d.id);
    expect(ids.slice(0, 5)).toEqual([
      'new', 'old', 'gemini-transcribe', 'gemini-transcribe-live', 'nvidia-parakeet',
    ]);
    expect(ids).toContain('faster-whisper-turbo');
    expect(DESCRIPTORS.some((d) => 'availability' in d)).toBe(false);
  });

  test('getEngineType defaults to gemini for an unknown method', () => {
    expect(getEngineType('totally-unknown')).toBe('gemini');
  });
});
