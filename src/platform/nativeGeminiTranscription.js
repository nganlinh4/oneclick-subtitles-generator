import { createNativeGeminiJobRunner } from './nativeGeminiJobLifecycle';

export const createNativeGeminiTranscription = (dependencies = {}) => {
  const runner = createNativeGeminiJobRunner(dependencies);
  const run = ({
    assetId,
    model,
    prompt,
    emptySpeechPolicy,
    responseJsonSchema,
    maxOutputTokens,
    thinkingLevel,
    mediaResolution,
    projectId,
    expectedProjectStateVersion,
    signal,
    onChunk,
    onStarted,
  }) => runner.run({
    request: {
      task: 'transcribe',
      model,
      prompt,
      mediaAssetId: assetId,
      ...(emptySpeechPolicy ? { emptySpeechPolicy } : {}),
      responseJsonSchema,
      maxOutputTokens,
      thinkingLevel,
      mediaResolution,
      ...(projectId !== undefined ? { projectId } : {}),
      ...(expectedProjectStateVersion !== undefined ? { expectedProjectStateVersion } : {}),
    },
    signal,
    onChunk,
    onStarted,
  });

  return Object.freeze({ run });
};

const nativeGeminiTranscription = createNativeGeminiTranscription();

export const runNativeGeminiTranscription = nativeGeminiTranscription.run;
