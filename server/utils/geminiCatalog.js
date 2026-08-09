const catalog = require('../../src/config/geminiModelCatalog.json');

const getModel = (id) => catalog.models.find((model) => model.id === id);
const getModelsForFeature = (feature) => catalog.models.filter(
  (model) => model.features.includes(feature)
);
const modelAcceptsMedia = (modelId) => {
  const model = getModel(modelId);
  return Boolean(model?.modalities.some((modality) => modality === 'audio' || modality === 'video'));
};

const getThinkingConfig = (modelId) => {
  const thinking = getModel(modelId)?.thinking;
  if (!thinking) return null;
  return thinking.type === 'level'
    ? { thinkingLevel: thinking.default.toUpperCase() }
    : { thinkingBudget: thinking.default };
};

module.exports = {
  catalog,
  getModel,
  getModelsForFeature,
  modelAcceptsMedia,
  getThinkingConfig
};
