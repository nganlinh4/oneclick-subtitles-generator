/**
 * Controller for Gemini API operations
 */
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

/**
 * Clean lyrics using Gemini API
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const cleanLyrics = async (req, res) => {
  try {
    const { lyrics } = req.body;

    if (!lyrics) {
      return res.status(400).json({ error: 'Missing lyrics' });
    }

    // Get Gemini API key from localStorage
    let geminiApiKey = null;
    try {
      const localStoragePath = path.join(process.cwd(), 'localStorage.json');
      const localStorageData = await fs.readFile(localStoragePath, 'utf-8');
      const localStorage = JSON.parse(localStorageData);
      geminiApiKey = localStorage.gemini_token;
    } catch (localStorageError) {
      console.error('Error reading localStorage file:', localStorageError);
    }

    if (!geminiApiKey) {
      return res.status(400).json({ error: 'Gemini API key not set. Please provide it through the settings.' });
    }

    // Call Gemini API to clean the lyrics
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${geminiApiKey}`,
      {
        contents: [
          {
            parts: [
              {
                text: `Please return the clean up version of these lyrics. I only want the lyrics lines, no blank lines, no square-bracketed indicators, no redundant info before the lyrics. Return only the cleaned lyrics without any explanation or additional text.

Original lyrics:
${lyrics}`
              }
            ]
          }
        ],
        generationConfig: {
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 8192,
        }
      },
      {
        headers: {
          ...(req.runId ? { 'X-Run-Id': req.runId } : {})
        }
      }
    );

    // Extract the cleaned lyrics from the response
    const cleanedLyrics = response.data.candidates[0].content.parts[0].text.trim();

    return res.json({ cleanedLyrics });
  } catch (error) {
    console.error('Error in cleanLyrics:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  cleanLyrics
};
