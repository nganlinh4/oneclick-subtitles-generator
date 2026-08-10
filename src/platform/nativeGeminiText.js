import { createNativeGeminiJobRunner } from './nativeGeminiJobLifecycle';

export const createNativeGeminiText = (dependencies = {}) => {
  const runner = createNativeGeminiJobRunner(dependencies);
  const run = ({
    task,
    model,
    prompt,
    systemInstruction,
    responseJsonSchema,
    maxOutputTokens,
    thinkingLevel,
    signal,
    onChunk,
    onStarted,
  }) => runner.run({
    request: {
      task,
      model,
      prompt,
      systemInstruction,
      responseJsonSchema,
      maxOutputTokens,
      thinkingLevel,
      mediaAssetId: null,
    },
    signal,
    onChunk,
    onStarted,
  });

  return Object.freeze({ run });
};

const nativeGeminiText = createNativeGeminiText();

export const runNativeGeminiText = nativeGeminiText.run;
