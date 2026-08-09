#!/usr/bin/env node
/* Validate the shared catalog, with optional live generateContent smoke tests. */
const fs = require('fs');
const path = require('path');
const catalog = require('../src/config/geminiModelCatalog.json');

const argumentsList = process.argv.slice(2);
const isLive = argumentsList.includes('--live');
const envFileIndex = argumentsList.indexOf('--env-file');
const envFile = envFileIndex >= 0 ? argumentsList[envFileIndex + 1] : null;
const videoFileIndex = argumentsList.indexOf('--video-file');
const videoFile = videoFileIndex >= 0 ? argumentsList[videoFileIndex + 1] : null;
const mediaModalities = new Set(['audio', 'video']);

const parseEnvFile = (filePath) => Object.fromEntries(
  fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((match) => {
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return [match[1], value];
    })
);

const assertCatalog = () => {
  const ids = catalog.models.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate ordinary Gemini model ID');
  if (!ids.includes(catalog.defaults.ordinary)) throw new Error('Ordinary default is missing');
  if (!catalog.imageGenerationModels.some(({ id }) => id === catalog.defaults.imageGeneration)) {
    throw new Error('Image-generation default is missing');
  }
  catalog.models.forEach((model) => {
    if (model.request.sampling !== 'provider-default') {
      throw new Error(`${model.id} must use provider-default sampling`);
    }
    if (!model.features.length || !model.modalities.length) {
      throw new Error(`${model.id} is missing capabilities`);
    }
    if (!model.modalities.some((modality) => mediaModalities.has(modality))) {
      throw new Error(`${model.id} cannot accept audio or video input`);
    }
  });
  catalog.liveAudioModels.forEach((model) => {
    if (!model.modalities?.includes('audio')) {
      throw new Error(`${model.id} is not an audio-capable Live model`);
    }
  });
};

const thinkingConfigFor = (model) => model.thinking.type === 'level'
  ? { thinkingLevel: model.thinking.default.toUpperCase() }
  : { thinkingBudget: model.thinking.default };

const audioProbe = fs.readFileSync(path.resolve(__dirname, '../server/example-audio/basic_ref_en.wav'));

const mediaPartFor = (model) => {
  if (model.modalities.includes('audio')) {
    return { inlineData: { mimeType: 'audio/wav', data: audioProbe.toString('base64') } };
  }
  if (model.modalities.includes('video')) {
    if (!videoFile) {
      throw new Error(`${model.id} requires --video-file PATH for its live media test`);
    }
    return {
      inlineData: {
        mimeType: 'video/mp4',
        data: fs.readFileSync(path.resolve(videoFile)).toString('base64')
      }
    };
  }
  throw new Error(`${model.id} has no supported media probe modality`);
};

const smokeModel = async (model, apiKey) => {
  const mediaPart = mediaPartFor(model);
  const testedModality = mediaPart.inlineData.mimeType.startsWith('audio/') ? 'audio' : 'video';
  const parts = [
    mediaPart,
    { text: `Inspect this ${testedModality} and return JSON with ok=true.` }
  ];
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok']
      },
      thinkingConfig: thinkingConfigFor(model)
    }
  };
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    }
  );
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 400)}`);
  }
  const data = JSON.parse(responseText);
  if (!data.candidates?.[0]?.content?.parts?.some((part) => part.text || part.thought)) {
    throw new Error('Response contained no candidate content');
  }
  return testedModality;
};

const main = async () => {
  assertCatalog();
  console.log(`Catalog OK: ${catalog.models.length} ordinary, ${catalog.liveAudioModels.length} Live, ${catalog.imageGenerationModels.length} image model(s).`);
  if (!isLive) return;

  const fileEnvironment = envFile ? parseEnvFile(path.resolve(envFile)) : {};
  const apiKey = process.env.GEMINI_API_KEY || fileEnvironment.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY was not found');

  const failures = [];
  for (const model of catalog.models) {
    process.stdout.write(`Testing ${model.id}... `);
    try {
      const testedModality = await smokeModel(model, apiKey);
      console.log(`${testedModality} OK`);
    } catch (error) {
      failures.push({ id: model.id, message: error.message });
      console.log('FAILED');
    }
  }
  if (failures.length) {
    failures.forEach(({ id, message }) => console.error(`${id}: ${message}`));
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
