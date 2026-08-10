#!/usr/bin/env node
/* Validate the shared catalog, with optional live generateContent smoke tests. */
const fs = require('fs');
const path = require('path');
const catalog = require('../src/config/geminiModelCatalog.json');

const argumentsList = process.argv.slice(2);
const isLive = argumentsList.includes('--live');
const envFileIndex = argumentsList.indexOf('--env-file');
const envFile = envFileIndex >= 0 ? argumentsList[envFileIndex + 1] : null;
const audioFileIndex = argumentsList.indexOf('--audio-file');
const audioFile = audioFileIndex >= 0 ? argumentsList[audioFileIndex + 1] : null;
const videoFileIndex = argumentsList.indexOf('--video-file');
const videoFile = videoFileIndex >= 0 ? argumentsList[videoFileIndex + 1] : null;
const mediaModalities = new Set(['audio', 'video']);
const nativeOrdinaryModels = [
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
];

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
  if (JSON.stringify(ids) !== JSON.stringify(nativeOrdinaryModels)) {
    throw new Error('Frontend ordinary models differ from the native provider allowlist');
  }
  if (!ids.includes(catalog.defaults.ordinary)) throw new Error('Ordinary default is missing');
  if (!catalog.imageGenerationModels.some(({ id }) => id === catalog.defaults.imageGeneration)) {
    throw new Error('Image-generation default is missing');
  }
  catalog.imageGenerationModels.forEach((model) => {
    if (model.lifecycle !== 'stable' || !model.modalities?.includes('video')) {
      throw new Error(`${model.id} must be stable and accept video input`);
    }
  });
  catalog.models.forEach((model) => {
    if (model.lifecycle !== 'stable') {
      throw new Error(`${model.id} is not a stable ordinary endpoint`);
    }
    if (model.request.sampling !== 'provider-default') {
      throw new Error(`${model.id} must use provider-default sampling`);
    }
    if (!model.features.length || !model.modalities.length) {
      throw new Error(`${model.id} is missing capabilities`);
    }
    if (![...mediaModalities].every((modality) => model.modalities.includes(modality))) {
      throw new Error(`${model.id} must accept both audio and video input`);
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

const readProbe = (filePath, mimeType) => ({
  inlineData: {
    mimeType,
    data: fs.readFileSync(path.resolve(filePath)).toString('base64')
  }
});

const loadLiveProbes = () => {
  const probes = [];
  if (audioFile) probes.push({ modality: 'audio', part: readProbe(audioFile, 'audio/wav') });
  if (videoFile) probes.push({ modality: 'video', part: readProbe(videoFile, 'video/mp4') });
  if (!probes.length) {
    throw new Error('Live catalog validation requires --audio-file PATH and/or --video-file PATH');
  }
  return probes;
};

const smokeModel = async (model, apiKey, probe) => {
  if (!model.modalities.includes(probe.modality)) {
    throw new Error(`${model.id} does not declare ${probe.modality} input support`);
  }
  const parts = [
    probe.part,
    { text: `Inspect this ${probe.modality} and return JSON with ok=true.` }
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
  return probe.modality;
};

const main = async () => {
  assertCatalog();
  console.log(`Catalog OK: ${catalog.models.length} ordinary, ${catalog.liveAudioModels.length} Live, ${catalog.imageGenerationModels.length} image model(s).`);
  if (!isLive) return;

  const fileEnvironment = envFile ? parseEnvFile(path.resolve(envFile)) : {};
  const apiKey = process.env.GEMINI_API_KEY || fileEnvironment.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY was not found');
  const probes = loadLiveProbes();

  const failures = [];
  for (const model of catalog.models) {
    for (const probe of probes) {
      process.stdout.write(`Testing ${model.id} (${probe.modality})... `);
      try {
        await smokeModel(model, apiKey, probe);
        console.log('OK');
      } catch (error) {
        failures.push({ id: model.id, modality: probe.modality, message: error.message });
        console.log('FAILED');
      }
    }
  }
  if (failures.length) {
    failures.forEach(({ id, modality, message }) => console.error(`${id} (${modality}): ${message}`));
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
