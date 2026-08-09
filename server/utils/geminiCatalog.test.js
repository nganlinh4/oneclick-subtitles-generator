const test = require('node:test');
const assert = require('node:assert/strict');
const {
  catalog,
  getModelsForFeature,
  getThinkingConfig,
  modelAcceptsMedia
} = require('./geminiCatalog');

test('Node server consumes the shared Gemini catalog', () => {
  assert.equal(catalog.defaults.fastText, 'gemini-3.5-flash-lite');
  assert.deepEqual(getThinkingConfig(catalog.defaults.fastText), { thinkingLevel: 'MINIMAL' });
  assert.equal(getModelsForFeature('backgroundPrompt').length, 7);
  assert.ok(catalog.models.every(({ id }) => modelAcceptsMedia(id)));
  assert.ok(catalog.liveAudioModels.every((model) => model.modalities.includes('audio')));
  assert.equal(catalog.imageGenerationModels.length, 1);
});
