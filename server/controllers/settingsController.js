/**
 * Controller for settings operations
 */
const fs = require('fs').promises;
const path = require('path');

/**
 * Update the prompts and models in the geminiImageController.js file
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const updatePrompts = async (req, res) => {
  try {
    const { promptOne, promptTwo, promptModel, imageModel } = req.body;

    if (!promptOne || !promptTwo) {
      return res.status(400).json({ error: 'Both prompts are required' });
    }

    // Check if promptTwo contains ${prompt}
    if (!promptTwo.includes('${prompt}')) {
      return res.status(400).json({ error: 'The second prompt must contain ${prompt}' });
    }

    // Optional: validate models if provided
    const allowedPromptModels = ['gemini-2.0-flash-lite', 'gemini-2.5-flash-lite'];
    const allowedImageModels = ['gemini-2.5-flash-image', 'gemini-2.0-flash-preview-image-generation'];

    if (promptModel && !allowedPromptModels.includes(promptModel)) {
      return res.status(400).json({ error: 'Invalid prompt model' });
    }
    if (imageModel && !allowedImageModels.includes(imageModel)) {
      return res.status(400).json({ error: 'Invalid image model' });
    }

    // Read the geminiImageController.js file
    const filePath = path.join(process.cwd(), 'server', 'controllers', 'geminiImageController.js');
    let content = await fs.readFile(filePath, 'utf-8');

    // Replace the first prompt (const content = `...`)
    const promptOneRegex = /(const content = `[\s\S]*?`;)/;
    content = content.replace(promptOneRegex, `const content = \`${promptOne}\`;`);

    // Replace the second prompt (const finalPrompt = `...`)
    const promptTwoRegex = /(const finalPrompt = `[\s\S]*?`;)/;
    content = content.replace(promptTwoRegex, `const finalPrompt = \`${promptTwo}\`;`);

    // Replace prompt generation model if provided
    if (promptModel) {
      const promptModelRegex = /(model:\s*')(gemini-2\.0-flash-lite|gemini-2\.5-flash-lite)(')/;
      content = content.replace(promptModelRegex, `$1${promptModel}$3`);
    }

    // Replace image generation model if provided
    if (imageModel) {
      const imageModelRegex = /(model:\s*')(gemini-2\.5-flash-image-preview|gemini-2\.0-flash-preview-image-generation)(')/;
      content = content.replace(imageModelRegex, `$1${imageModel}$3`);
    }

    // Write the updated content back to the file
    await fs.writeFile(filePath, content, 'utf-8');

    // Persist selected models to localStorage.json so runtime can use them without restart
    try {
      const storagePath = path.join(process.cwd(), 'localStorage.json');
      let storage = {};
      try {
        const storageRaw = await fs.readFile(storagePath, 'utf-8');
        storage = JSON.parse(storageRaw || '{}');
      } catch (_) {
        storage = {};
      }
      if (promptModel) storage.background_prompt_model = promptModel;
      if (imageModel) storage.background_image_model = imageModel;
      await fs.writeFile(storagePath, JSON.stringify(storage, null, 2), 'utf-8');
    } catch (persistErr) {
      console.warn('Warning: failed to persist models to localStorage.json', persistErr);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating prompts:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  updatePrompts
};
