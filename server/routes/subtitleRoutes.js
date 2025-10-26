/**
 * API routes for subtitle operations
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { SUBTITLES_DIR } = require('../config');

// Create directories for user-provided subtitles and transcription rules
const USER_SUBTITLES_DIR = path.join(SUBTITLES_DIR, 'user-provided');
const RULES_DIR = path.join(SUBTITLES_DIR, 'rules');

// Ensure directories exist
if (!fs.existsSync(USER_SUBTITLES_DIR)) {
  fs.mkdirSync(USER_SUBTITLES_DIR, { recursive: true });

}

if (!fs.existsSync(RULES_DIR)) {
  fs.mkdirSync(RULES_DIR, { recursive: true });

}

/**
 * GET /api/subtitle-exists/:cacheId - Check if subtitles exist
 */
router.get('/subtitle-exists/:cacheId', (req, res) => {
  const { cacheId } = req.params;
  const subtitlePath = path.join(SUBTITLES_DIR, `${cacheId}.json`);

  if (fs.existsSync(subtitlePath)) {

    try {
      const subtitlesData = JSON.parse(fs.readFileSync(subtitlePath, 'utf8'));
      res.json({
        exists: true,
        subtitles: subtitlesData
      });
    } catch (error) {
      console.error('Error reading cached subtitles:', error);
      res.json({ exists: false });
    }
  } else {

    res.json({ exists: false });
  }
});

/**
 * POST /api/save-subtitles - Save subtitles
 */
router.post('/save-subtitles', (req, res) => {
  const { cacheId, subtitles } = req.body;

  if (!cacheId || !subtitles) {
    return res.status(400).json({
      success: false,
      error: 'Missing required data (cacheId or subtitles)'
    });
  }

  try {
    const subtitlePath = path.join(SUBTITLES_DIR, `${cacheId}.json`);
    fs.writeFileSync(subtitlePath, JSON.stringify(subtitles, null, 2));


    res.json({
      success: true,
      message: 'Subtitles saved to cache successfully'
    });
  } catch (error) {
    console.error('Error saving subtitles to cache:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save subtitles to cache'
    });
  }
});

/**
 * GET /api/user-subtitles/:cacheId - Check if user-provided subtitles exist
 */
router.get('/user-subtitles/:cacheId', (req, res) => {
  const { cacheId } = req.params;
  const subtitlePath = path.join(USER_SUBTITLES_DIR, `${cacheId}.txt`);

  if (fs.existsSync(subtitlePath)) {

    try {
      const subtitlesText = fs.readFileSync(subtitlePath, 'utf8');
      res.json({
        exists: true,
        subtitlesText
      });
    } catch (error) {
      console.error('Error reading cached user-provided subtitles:', error);
      res.json({ exists: false });
    }
  } else {

    res.json({ exists: false });
  }
});

/**
 * POST /api/save-user-subtitles - Save user-provided subtitles
 */
router.post('/save-user-subtitles', (req, res) => {
  const { cacheId, subtitlesText } = req.body;

  if (!cacheId || subtitlesText === undefined) {
    return res.status(400).json({
      success: false,
      error: 'Missing required data (cacheId or subtitlesText)'
    });
  }

  try {
    const subtitlePath = path.join(USER_SUBTITLES_DIR, `${cacheId}.txt`);
    fs.writeFileSync(subtitlePath, subtitlesText);


    res.json({
      success: true,
      message: 'User-provided subtitles saved to cache successfully'
    });
  } catch (error) {
    console.error('Error saving user-provided subtitles to cache:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save user-provided subtitles to cache'
    });
  }
});

/**
 * GET /api/rules/:cacheId - Check if transcription rules exist
 */
router.get('/rules/:cacheId', (req, res) => {
  const { cacheId } = req.params;
  const rulesPath = path.join(RULES_DIR, `${cacheId}.json`);

  if (fs.existsSync(rulesPath)) {

    try {
      const rulesData = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
      res.json({
        exists: true,
        rules: rulesData
      });
    } catch (error) {
      console.error('Error reading cached transcription rules:', error);
      res.json({ exists: false });
    }
  } else {

    res.json({ exists: false });
  }
});

/**
 * POST /api/save-rules - Save transcription rules
 */
router.post('/save-rules', (req, res) => {
  const { cacheId, rules } = req.body;

  if (!cacheId || !rules) {
    return res.status(400).json({
      success: false,
      error: 'Missing required data (cacheId or rules)'
    });
  }

  try {
    const rulesPath = path.join(RULES_DIR, `${cacheId}.json`);
    fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2));


    res.json({
      success: true,
      message: 'Transcription rules saved to cache successfully'
    });
  } catch (error) {
    console.error('Error saving transcription rules to cache:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save transcription rules to cache'
    });
  }
});

/**
 * POST /api/delete-subtitles - Delete subtitle files to force regeneration
 */
router.post('/delete-subtitles', (req, res) => {
  const { videoUrl, fileName, cacheId } = req.body;

  console.log('DELETE SUBTITLES: Request received with:', { videoUrl, fileName, cacheId });

  let deletedFiles = [];
  let errors = [];

  try {
    // Try to delete files based on different identifiers
    const possibleFiles = [];

    // If we have a cacheId, use it directly
    if (cacheId) {
      possibleFiles.push(`${cacheId}.json`);
    }

    // If we have a fileName, create possible cache IDs from it
    if (fileName) {
      const baseName = path.parse(fileName).name;
      possibleFiles.push(`${baseName}.json`);
      // Also try with some common hash patterns
      possibleFiles.push(`file_${baseName}.json`);
    }

    // If we have a videoUrl, create possible cache IDs from it
    if (videoUrl) {
      // Extract video ID from YouTube URLs
      const youtubeMatch = videoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (youtubeMatch) {
        possibleFiles.push(`${youtubeMatch[1]}.json`);
        possibleFiles.push(`youtube_${youtubeMatch[1]}.json`);
      }
    }

    // Also try to find any .json files in the subtitles directory that might match
    if (fs.existsSync(SUBTITLES_DIR)) {
      const allFiles = fs.readdirSync(SUBTITLES_DIR);
      const jsonFiles = allFiles.filter(file => file.endsWith('.json'));

      // Add all JSON files to possible files (for aggressive cleanup)
      possibleFiles.push(...jsonFiles);
    }

    console.log('DELETE SUBTITLES: Possible files to delete:', possibleFiles);

    // Remove duplicates
    const uniqueFiles = [...new Set(possibleFiles)];

    // Try to delete each file
    for (const fileName of uniqueFiles) {
      const filePath = path.join(SUBTITLES_DIR, fileName);

      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          deletedFiles.push(fileName);
          console.log('DELETE SUBTITLES: Deleted file:', fileName);
        } catch (error) {
          console.error('DELETE SUBTITLES: Error deleting file:', fileName, error);
          errors.push(`Failed to delete ${fileName}: ${error.message}`);
        }
      }
    }

    // Also try to delete user-provided subtitles
    if (cacheId) {
      const userSubtitlePath = path.join(USER_SUBTITLES_DIR, `${cacheId}.txt`);
      if (fs.existsSync(userSubtitlePath)) {
        try {
          fs.unlinkSync(userSubtitlePath);
          deletedFiles.push(`user-provided/${cacheId}.txt`);
          console.log('DELETE SUBTITLES: Deleted user subtitle file:', `${cacheId}.txt`);
        } catch (error) {
          console.error('DELETE SUBTITLES: Error deleting user subtitle file:', error);
          errors.push(`Failed to delete user subtitle file: ${error.message}`);
        }
      }
    }

    console.log('DELETE SUBTITLES: Operation completed. Deleted:', deletedFiles.length, 'files. Errors:', errors.length);

    res.json({
      success: true,
      message: `Deleted ${deletedFiles.length} subtitle files`,
      deletedFiles,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('DELETE SUBTITLES: Unexpected error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete subtitle files',
      details: error.message
    });
  }

});


/**
 * POST /api/download-best-subtitle - Try to fetch the best site-provided subtitle via yt-dlp
 */
router.post('/download-best-subtitle', async (req, res) => {
  try {
    const { url, preferredLangs = [], useCookies = false } = req.body || {};
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }
    const { downloadBestSubtitle } = require('../services/shared/subtitleDownloader');
    const result = await downloadBestSubtitle(url, preferredLangs, useCookies);
    if (!result.success) {
      const status = result.reason === 'NO_SUBS' ? 204 : 502;
      return res.status(status).json({ success: false, ...result });
    }
    res.json({
      success: true,
      id: result.id,
      lang: result.lang,
      source: result.source,
      fileName: result.fileName,
      content: result.content
    });
  } catch (error) {
    let conciseError = 'Failed to download subtitles';
    if (error.message.includes('Fresh cookies') || error.message.includes('cookies')) {
      conciseError = 'Authentication required - please try with cookies enabled';
      console.error('[download-best-subtitle] Authentication required for subtitle download');
    } else {
      console.error('[download-best-subtitle] Error:', error);
    }
    res.status(500).json({ success: false, error: conciseError });
  }
});

module.exports = router;
