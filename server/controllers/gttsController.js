/**
 * gTTS Controller for generating narration using Google Text-to-Speech
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

// Import cleanup function
const { cleanupOldSubtitleDirectories } = require('./narration/directoryManager');

// Check if we're in the project directory and have .venv
const projectRoot = process.cwd();
const venvPath = path.join(projectRoot, '.venv');
const pythonExecutable = process.platform === 'win32' 
  ? path.join(venvPath, 'Scripts', 'python.exe')
  : path.join(venvPath, 'bin', 'python');

/**
 * Get available gTTS languages
 */
const getLanguages = async (req, res) => {
  try {
    // Create a temporary Python script to get languages
    const tempScript = path.join(os.tmpdir(), `gtts_languages_${uuidv4()}.py`);
    const scriptContent = `
import json
import sys

try:
    from gtts.lang import tts_langs
    
    languages = tts_langs()
    formatted_languages = []
    for code, name in languages.items():
        formatted_languages.append({
            'code': code,
            'name': name,
            'display_name': f"{name} ({code})"
        })
    
    print(json.dumps({'languages': formatted_languages}))
    
except ImportError:
    print(json.dumps({'error': 'gtts library not available'}))
    sys.exit(1)
except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(1)
`;

    fs.writeFileSync(tempScript, scriptContent);

    // Execute the Python script
    const pythonProcess = spawn(pythonExecutable, [tempScript], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    pythonProcess.on('close', (code) => {
      // Clean up temp file
      try {
        fs.unlinkSync(tempScript);
      } catch (e) {
        // Ignore cleanup errors
      }

      if (code !== 0) {
        console.error('gTTS languages error:', stderr);
        return res.status(500).json({ error: 'Failed to get gTTS languages' });
      }

      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          return res.status(503).json(result);
        }
        res.json(result);
      } catch (parseError) {
        console.error('Failed to parse languages response:', parseError);
        res.status(500).json({ error: 'Failed to parse languages response' });
      }
    });

  } catch (error) {
    console.error('Error getting gTTS languages:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Generate gTTS narration
 */
const generateNarration = async (req, res) => {
  try {
    const { subtitles, settings } = req.body;

    if (!subtitles || !Array.isArray(subtitles)) {
      return res.status(400).json({ error: 'Invalid subtitles data' });
    }

    const lang = settings?.lang || 'en';
    const tld = settings?.tld || 'com';
    const slow = settings?.slow || false;

    // Set up Server-Sent Events
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Send start event
    res.write(`data: ${JSON.stringify({ status: 'started', total: subtitles.length })}\n\n`);

    const results = [];
    const outputDir = path.join(projectRoot, 'narration', 'output');

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Process each subtitle
    for (let i = 0; i < subtitles.length; i++) {
      const subtitle = subtitles[i];
      
      try {
        // Create temporary Python script for this subtitle
        const tempScript = path.join(os.tmpdir(), `gtts_generate_${uuidv4()}.py`);

        // Create subtitle directory (same as F5-TTS/Chatterbox pattern)
        const subtitleDir = path.join(outputDir, `subtitle_${subtitle.id || i}`);
        if (!fs.existsSync(subtitleDir)) {
          fs.mkdirSync(subtitleDir, { recursive: true });
        }

        // Always use 1.mp3 to override existing narrations for the same video/subtitle set
        // This ensures align-narration always finds the latest narration
        const filename = '1.mp3';
        const outputPath = path.join(subtitleDir, filename);

        // If file exists, it will be overwritten (this is intentional)
        if (fs.existsSync(outputPath)) {
          console.log(`Overriding existing narration: ${outputPath}`);

          // Clear backup audio file created by speed control to prevent dangerous risks
          const backupFilename = `backup_${filename}`;
          const backupPath = path.join(subtitleDir, backupFilename);
          if (fs.existsSync(backupPath)) {
            try {
              fs.unlinkSync(backupPath);
              console.log(`Cleared backup file: ${backupPath}`);
            } catch (backupError) {
              console.warn(`Failed to clear backup file ${backupPath}: ${backupError.message}`);
            }
          }
        }

        // Full filename for response (includes subtitle directory)
        const fullFilename = `subtitle_${subtitle.id || i}/${filename}`;

        const scriptContent = `
import json
import sys
import tempfile
import os

try:
    from gtts import gTTS
    
    text = """${subtitle.text.replace(/"/g, '\\"')}"""
    lang = "${lang}"
    tld = "${tld}"
    slow = ${slow ? 'True' : 'False'}
    
    tts = gTTS(text=text, lang=lang, tld=tld, slow=slow)
    
    # Save to output file
    tts.save("${outputPath.replace(/\\/g, '\\\\')}")
    
    print(json.dumps({'success': True, 'filename': '${fullFilename}'}))
    
except ImportError:
    print(json.dumps({'success': False, 'error': 'gtts library not available'}))
    sys.exit(1)
except Exception as e:
    print(json.dumps({'success': False, 'error': str(e)}))
    sys.exit(1)
`;

        fs.writeFileSync(tempScript, scriptContent);

        // Execute the Python script
        const result = await new Promise((resolve, reject) => {
          const pythonProcess = spawn(pythonExecutable, [tempScript], {
            stdio: ['pipe', 'pipe', 'pipe']
          });

          let stdout = '';
          let stderr = '';

          pythonProcess.stdout.on('data', (data) => {
            stdout += data.toString();
          });

          pythonProcess.stderr.on('data', (data) => {
            stderr += data.toString();
          });

          pythonProcess.on('close', (code) => {
            // Clean up temp file
            try {
              fs.unlinkSync(tempScript);
            } catch (e) {
              // Ignore cleanup errors
            }

            if (code !== 0) {
              reject(new Error(stderr || 'Python process failed'));
              return;
            }

            try {
              const result = JSON.parse(stdout);
              resolve(result);
            } catch (parseError) {
              reject(new Error('Failed to parse result'));
            }
          });
        });

        const subtitleResult = {
          subtitle_id: subtitle.id || i,
          text: subtitle.text,
          start_time: subtitle.start || 0,
          end_time: subtitle.end || 0,
          filename: result.success ? result.filename : null,
          success: result.success,
          error: result.error || null,
          method: 'gtts'
        };

        results.push(subtitleResult);

        // Send progress event
        res.write(`data: ${JSON.stringify({
          status: 'progress',
          current: i + 1,
          total: subtitles.length,
          result: subtitleResult
        })}\n\n`);

      } catch (error) {
        console.error(`Error generating gTTS for subtitle ${i}:`, error);
        
        const errorResult = {
          subtitle_id: subtitle.id || i,
          text: subtitle.text,
          success: false,
          error: error.message,
          method: 'gtts'
        };

        results.push(errorResult);

        res.write(`data: ${JSON.stringify({
          status: 'error',
          current: i + 1,
          total: subtitles.length,
          result: errorResult
        })}\n\n`);
      }
    }

    // Clean up old subtitle directories if using grouped subtitles
    const hasGroupedSubtitles = subtitles.some(subtitle => subtitle.original_ids && subtitle.original_ids.length > 0);
    const skipCleanup = settings?.skipCleanup === true || settings?.skipClearOutput === true || settings?.retryMode === 'single' || settings?.retryMode === 'failed';
    if (hasGroupedSubtitles && !skipCleanup) {
      console.log('gTTS: Detected grouped subtitles, cleaning up old directories');
      cleanupOldSubtitleDirectories(subtitles);
    } else if (hasGroupedSubtitles && skipCleanup) {
      console.log('gTTS: Detected grouped subtitles, but skipping cleanup due to retry/skip flag');
    }

    // Send completion event
    res.write(`data: ${JSON.stringify({
      status: 'completed',
      results: results
    })}\n\n`);

    res.end();

  } catch (error) {
    console.error('Error in gTTS generation:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getLanguages,
  generateNarration
};
