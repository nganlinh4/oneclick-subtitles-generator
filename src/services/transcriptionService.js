import { DEFAULT_TRANSCRIPTION_MODEL_ID } from '../config/geminiModels';
import { importAudioBlob, releaseAudioBlob } from '../platform/mediaService';
import { runNativeGeminiTranscription } from '../platform/nativeGeminiTranscription';
import { toBase64 } from '../utils/fileUtils';

// Retained for non-provider callers that depend on this utility export.
export const blobToBase64 = toBase64;

export const isTextEnglish = (text) => {
  if (!text) return true;
  const normalizedText = text
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()\n]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = normalizedText.split(/\s+/);
  const nonLatinPattern = /[^\u0020-\u007F\u00C0-\u00FF\u0100-\u017F]/;
  if (words.length <= 3) return !nonLatinPattern.test(normalizedText);

  const commonEnglishWords = new Set([
    'the', 'and', 'is', 'in', 'to', 'of', 'a', 'for', 'that', 'this', 'you', 'it', 'with',
    'on', 'at', 'hello', 'hi', 'hey', 'how', 'are', 'what', 'when', 'where', 'why', 'who',
    'which', 'me', 'my', 'your', 'we', 'they', 'them', 'their', 'our', 'us', 'he', 'she',
    'his', 'her', 'i', 'am', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does',
    'did', 'can', 'could', 'will', 'would', 'should', 'may', 'might', 'must', 'shall', 'girl',
    'boy', 'man', 'woman', 'people', 'person', 'thing', 'time', 'day', 'year', 'good', 'bad',
    'yes', 'no', 'not', 'all', 'some', 'any', 'many', 'much', 'more', 'most', 'other',
    'another', 'such', 'very', 'just', 'than', 'then', 'now', 'here', 'there',
  ]);
  const englishWordCount = words.filter((word) => commonEnglishWords.has(word)).length;
  return !nonLatinPattern.test(normalizedText)
    && ((englishWordCount / words.length) * 100 >= 30 || englishWordCount >= 2);
};

/** Transcribe an ephemeral audio blob through the native vault-backed Gemini pipeline. */
export const transcribeAudio = async (audioBlob) => {
  let importedAudio = null;
  try {
    importedAudio = await importAudioBlob(audioBlob);
    const result = await runNativeGeminiTranscription({
      assetId: importedAudio.assetId,
      model: DEFAULT_TRANSCRIPTION_MODEL_ID,
      prompt: 'Transcribe this audio. Return ONLY the transcription, no other text.',
    });
    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    if (!text) {
      return {
        text: '',
        is_english: false,
        language: 'Unknown',
        no_result: true,
      };
    }
    const isEnglish = isTextEnglish(text);
    return {
      text,
      is_english: isEnglish,
      language: isEnglish ? 'English' : 'Unknown',
    };
  } finally {
    if (importedAudio !== null) {
      await releaseAudioBlob(importedAudio.assetId).catch(() => undefined);
    }
  }
};
