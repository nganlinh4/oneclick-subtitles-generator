/**
 * Transcription service for voice recognition using Gemini API
 */

import { toBase64 } from '../utils/fileUtils';
import { fetchWithKeyRotation } from './gemini/withKeyRotation';
import { addThinkingConfig } from '../utils/thinkingBudgetUtils';
import { DEFAULT_TRANSCRIPTION_MODEL_ID } from '../config/geminiModels';

// blobToBase64 is the shared toBase64 helper; kept as a named export for existing call sites.
export const blobToBase64 = toBase64;

/**
 * Detect if text is in English
 * @param {string} text - The text to check
 * @returns {boolean} - True if the text is in English
 */
export const isTextEnglish = (text) => {
  if (!text) return true;

  // Normalize the text - remove punctuation and extra whitespace
  const normalizedText = text.toLowerCase().replace(/[.,/#!$%^&*;:{}=\-_`~()\n]/g, '').replace(/\s+/g, ' ').trim();

  // Simple detection based on common English words and characters
  const englishWords = ['the', 'and', 'is', 'in', 'to', 'of', 'a', 'for', 'that', 'this', 'you', 'it', 'with', 'on', 'at',
                       'hello', 'hi', 'hey', 'how', 'are', 'what', 'when', 'where', 'why', 'who', 'which', 'me', 'my', 'your',
                       'we', 'they', 'them', 'their', 'our', 'us', 'he', 'she', 'his', 'her', 'i', 'am', 'was', 'were', 'be',
                       'been', 'have', 'has', 'had', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'may',
                       'might', 'must', 'shall', 'girl', 'boy', 'man', 'woman', 'people', 'person', 'thing', 'time', 'day',
                       'year', 'good', 'bad', 'yes', 'no', 'not', 'all', 'some', 'any', 'many', 'much', 'more', 'most',
                       'other', 'another', 'such', 'very', 'just', 'than', 'then', 'now', 'here', 'there'];

  const words = normalizedText.split(/\s+/);

  // If the text is very short (1-3 words), assume it's English unless proven otherwise
  if (words.length <= 3) {
    // Check for non-Latin characters that would indicate non-English
    const nonLatinPattern = /[^\u0020-\u007F\u00C0-\u00FF\u0100-\u017F]/;
    return !nonLatinPattern.test(normalizedText);
  }

  // Count English words
  const englishWordCount = words.filter(word => englishWords.includes(word)).length;

  // Calculate the percentage of English words
  const englishPercentage = (englishWordCount / words.length) * 100;

  // Check for non-Latin characters
  const nonLatinPattern = /[^\u0020-\u007F\u00C0-\u00FF\u0100-\u017F]/;
  const hasNonLatin = nonLatinPattern.test(normalizedText);

  // If there are non-Latin characters or very few English words, it's probably not English
  // For longer texts, require at least 30% English words
  // For shorter texts, require at least 2 English words
  if (hasNonLatin || (englishPercentage < 30 && englishWordCount < 2)) {
    return false;
  }

  return true;
};

/**
 * Transcribe audio using Gemini API
 * @param {Blob} audioBlob - Audio blob to transcribe
 * @returns {Promise<Object>} - Transcription result
 */
export const transcribeAudio = async (audioBlob) => {
  console.time('transcribeAudio');

  try {
    // Convert blob to base64
    const base64Audio = await blobToBase64(audioBlob);
    console.timeLog('transcribeAudio', 'Blob to base64 conversion');

    // Prepare request data for transcription
    const model = DEFAULT_TRANSCRIPTION_MODEL_ID;
    let requestData = {
      contents: [
        {
          role: "user",
          parts: [
            { text: "Transcribe this audio. Return ONLY the transcription, no other text." },
            {
              inlineData: {
                mimeType: "audio/wav",
                data: base64Audio
              }
            }
          ]
        }
      ]
    };
    requestData = addThinkingConfig(requestData, model);



    // Call Gemini API (key rotation handles key selection and auto-switch on 429)
    const response = await fetchWithKeyRotation((apiKey) =>
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestData)
        }
      )
    );

    console.timeLog('transcribeAudio', 'Received response from Gemini API');

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Gemini API error:', errorData);
      throw new Error(`API error during transcription: ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();

    // Extract the transcription text from the response safely
    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    const firstCandidate = candidates[0];
    const parts = Array.isArray(firstCandidate?.content?.parts) ? firstCandidate.content.parts : [];
    const transcriptionText = typeof parts[0]?.text === 'string' ? parts[0].text : '';

    if (transcriptionText) {
      // Clean up the transcription text (remove extra whitespace, etc.)
      const cleanedText = transcriptionText.trim();

      // Check if the text is in English
      const isEnglish = isTextEnglish(cleanedText);

      console.timeEnd('transcribeAudio');

      return {
        text: cleanedText,
        is_english: isEnglish,
        language: isEnglish ? 'English' : 'Unknown'
      };
    } else {
      // Gracefully handle cases where Gemini returns no result
      console.warn('Gemini returned no transcription candidates or empty text:', data);
      console.timeEnd('transcribeAudio');
      return {
        text: '',
        is_english: false,
        language: 'Unknown',
        no_result: true
      };
    }
  } catch (error) {
    console.error('Error transcribing audio:', error);
    console.timeEnd('transcribeAudio');
    throw error;
  }
};
