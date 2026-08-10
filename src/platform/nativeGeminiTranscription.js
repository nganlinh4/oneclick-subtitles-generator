import { createNativeGeminiJobRunner } from './nativeGeminiJobLifecycle';

export const createNativeGeminiTranscription = (dependencies = {}) => {
  const runner = createNativeGeminiJobRunner(dependencies);
  const run = ({
    assetId,
    model,
    prompt,
    responseJsonSchema,
    maxOutputTokens,
    thinkingLevel,
    mediaResolution,
    signal,
    onChunk,
    onStarted,
  }) => runner.run({
    request: {
      task: 'transcribe',
      model,
      prompt,
      mediaAssetId: assetId,
      responseJsonSchema,
      maxOutputTokens,
      thinkingLevel,
      mediaResolution,
    },
    signal,
    onChunk,
    onStarted,
  });

  return Object.freeze({ run });
};

const nativeGeminiTranscription = createNativeGeminiTranscription();

export const runNativeGeminiTranscription = nativeGeminiTranscription.run;
