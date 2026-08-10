import { createNativeGeminiJobRunner } from './nativeGeminiJobLifecycle';

export const createNativeGeminiMediaAnalysis = (dependencies = {}) => {
  const runner = dependencies.runner ?? createNativeGeminiJobRunner(dependencies);
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
      task: 'analyzeSubtitles',
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

const nativeGeminiMediaAnalysis = createNativeGeminiMediaAnalysis();

export const runNativeGeminiMediaAnalysis = nativeGeminiMediaAnalysis.run;
