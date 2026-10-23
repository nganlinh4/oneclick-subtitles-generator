// A Gemini model id that always resolves to a catalog model accepting audio or video. The catalog
// is consulted lazily so declaring a key never depends on it at module load.
import { normalizeMediaModelId } from '../../config/geminiModels';

const MAX_MODEL_ID_LENGTH = 256;

export const mediaModel = (defaultModelId) => Object.freeze({
  get fallback() { return defaultModelId(); },
  decode: (raw) => normalizeMediaModelId(
    typeof raw === 'string' && raw.length <= MAX_MODEL_ID_LENGTH ? raw : null,
    defaultModelId(),
  ),
  normalize: (value) => {
    if (typeof value !== 'string' || value.length > MAX_MODEL_ID_LENGTH) {
      throw new TypeError('A model id preference is required');
    }
    return normalizeMediaModelId(value, defaultModelId());
  },
  encode: (value) => value,
});
