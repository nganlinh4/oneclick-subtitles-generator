/** Persist background-generation settings without rewriting application source code. */
const fs = require('fs').promises;
const path = require('path');
const { catalog, getModelsForFeature } = require('../utils/geminiCatalog');

const PROMPT_MODEL_IDS = new Set(getModelsForFeature('backgroundPrompt').map(({ id }) => id));
const IMAGE_MODEL_IDS = new Set(catalog.imageGenerationModels.map(({ id }) => id));

const updatePrompts = async (req, res) => {
  try {
    const { promptOne, promptTwo, promptModel, imageModel } = req.body;

    if (typeof promptOne !== 'string' || typeof promptTwo !== 'string' || !promptOne.trim() || !promptTwo.trim()) {
      return res.status(400).json({ error: 'Both prompts are required' });
    }
    if (!promptTwo.includes('${prompt}')) {
      return res.status(400).json({ error: 'The second prompt must contain ${prompt}' });
    }
    if (promptModel && !PROMPT_MODEL_IDS.has(promptModel)) {
      return res.status(400).json({ error: 'Invalid prompt model' });
    }
    if (imageModel && !IMAGE_MODEL_IDS.has(imageModel)) {
      return res.status(400).json({ error: 'Invalid image model' });
    }

    const storagePath = path.join(process.cwd(), 'localStorage.json');
    let storage = {};
    try {
      storage = JSON.parse(await fs.readFile(storagePath, 'utf-8') || '{}');
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }

    storage.background_prompt_one = promptOne;
    storage.background_prompt_two = promptTwo;
    storage.background_prompt_model = promptModel || catalog.defaults.backgroundPrompt;
    storage.background_image_model = imageModel || catalog.defaults.imageGeneration;
    await fs.writeFile(storagePath, JSON.stringify(storage, null, 2), 'utf-8');

    return res.json({ success: true });
  } catch (error) {
    console.error('Error updating background prompts:', error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports = { updatePrompts };
