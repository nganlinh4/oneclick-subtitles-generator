/** Capability checks backed by the central Gemini catalog. */
import { getModelById, migrateGeminiModelId } from '../../config/geminiModels';

const UNSUPPORTED_CUSTOM_MEDIA_RESOLUTION_MODELS = [
  'learnlm-2.0-flash-experimental',
  'learnlm-2.0-flash',
  'learnlm-1.5-flash'
];

export const supportsMediaResolution = (modelId) => {
  const normalized = migrateGeminiModelId(modelId);
  const builtIn = getModelById(normalized);
  if (builtIn) return builtIn.request.mediaResolution;

  return !UNSUPPORTED_CUSTOM_MEDIA_RESOLUTION_MODELS.some((unsupported) =>
    normalized.includes(unsupported)
  );
};
