/**
 * Edge TTS Controller for generating narration using Microsoft Edge TTS
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
 * Get available Edge TTS voices
 */
const getVoices = async (req, res) => {
  try {
    // Create a temporary Python script to get voices
    const tempScript = path.join(os.tmpdir(), `edge_tts_voices_${uuidv4()}.py`);
    const scriptContent = `
import asyncio
import json
import sys

try:
    import edge_tts
    
    async def get_voices():
        voices = await edge_tts.list_voices()
        formatted_voices = []
        for voice in voices:
            formatted_voices.append({
                'name': voice['Name'],
                'short_name': voice['ShortName'],
                'gender': voice['Gender'],
                'locale': voice['Locale'],
                'language': voice['Locale'].split('-')[0],
                'display_name': f"{voice['DisplayName']} ({voice['Locale']})"
            })
        return formatted_voices
    
    voices = asyncio.run(get_voices())
    print(json.dumps({'voices': voices}))
    
except ImportError:
    print(json.dumps({'error': 'edge-tts library not available'}))
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
        console.error('Edge TTS voices error:', stderr);
        return res.status(500).json({ error: 'Failed to get Edge TTS voices' });
      }

      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          return res.status(503).json(result);
        }
        res.json(result);
      } catch (parseError) {
        console.error('Failed to parse voices response:', parseError);
        res.status(500).json({ error: 'Failed to parse voices response' });
      }
    });

  } catch (error) {
    console.error('Error getting Edge TTS voices:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Generate Edge TTS narration
 */
const generateNarration = async (req, res) => {
  try {
    console.log(`[Edge TTS] Starting narration generation`);
    console.log(`[Edge TTS] Python executable: ${pythonExecutable}`);
    console.log(`[Edge TTS] Python executable exists: ${fs.existsSync(pythonExecutable)}`);
    console.log(`[Edge TTS] Virtual environment path: ${venvPath}`);
    console.log(`[Edge TTS] Virtual environment exists: ${fs.existsSync(venvPath)}`);

    const { subtitles, settings } = req.body;

    if (!subtitles || !Array.isArray(subtitles)) {
      return res.status(400).json({ error: 'Invalid subtitles data' });
    }

    console.log(`[Edge TTS] Processing ${subtitles.length} subtitles`);

    const voice = settings?.voice || 'en-US-AriaNeural';
    const rate = settings?.rate || '+0%';
    const volume = settings?.volume || '+0%';
    const pitch = settings?.pitch || '+0Hz';

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

      console.log(`[Edge TTS] Processing subtitle ${i + 1}/${subtitles.length}:`);
      console.log(`[Edge TTS] Text: "${subtitle.text}"`);
      console.log(`[Edge TTS] ID: ${subtitle.id || i}`);
      console.log(`[Edge TTS] Voice settings: ${voice}, Rate: ${rate}, Volume: ${volume}, Pitch: ${pitch}`);
    console.log(`[Edge TTS] Voice type: ${typeof voice}, Voice length: ${voice.length}`);

      try {
        // Create temporary Python script for this subtitle
        const tempScript = path.join(os.tmpdir(), `edge_tts_generate_${uuidv4()}.py`);
        console.log(`[Edge TTS] Created temp script: ${tempScript}`);

        // Create subtitle directory (same as F5-TTS/Chatterbox pattern)
        const subtitleDir = path.join(outputDir, `subtitle_${subtitle.id || i}`);
        console.log(`[Edge TTS] Subtitle directory: ${subtitleDir}`);
        if (!fs.existsSync(subtitleDir)) {
          fs.mkdirSync(subtitleDir, { recursive: true });
          console.log(`[Edge TTS] Created subtitle directory: ${subtitleDir}`);
        } else {
          console.log(`[Edge TTS] Subtitle directory already exists: ${subtitleDir}`);
        }

        // Always use 1.mp3 to override existing narrations for the same video/subtitle set
        // This ensures align-narration always finds the latest narration
        const filename = '1.mp3';
        const outputPath = path.join(subtitleDir, filename);
        console.log(`[Edge TTS] Output path: ${outputPath}`);

        // If file exists, it will be overwritten (this is intentional)
        if (fs.existsSync(outputPath)) {
          console.log(`[Edge TTS] Overriding existing narration: ${outputPath}`);

          // Clear backup audio file created by speed control to prevent dangerous risks
          const backupFilename = `backup_${filename}`;
          const backupPath = path.join(subtitleDir, backupFilename);
          if (fs.existsSync(backupPath)) {
            try {
              fs.unlinkSync(backupPath);
              console.log(`[Edge TTS] Cleared backup file: ${backupPath}`);
            } catch (backupError) {
              console.warn(`[Edge TTS] Failed to clear backup file ${backupPath}: ${backupError.message}`);
            }
          }
        } else {
          console.log(`[Edge TTS] Creating new narration file: ${outputPath}`);
        }

        // Full filename for response (includes subtitle directory)
        const fullFilename = `subtitle_${subtitle.id || i}/${filename}`;

        const scriptContent = `
import asyncio
import json
import sys
import subprocess
import tempfile
import os

try:
    import edge_tts

    async def generate_audio():
        text = """${subtitle.text.replace(/"/g, '\\"')}"""
        voice = "${voice}"
        rate = "${rate}"
        volume = "${volume}"
        pitch = "${pitch}"
        output_path = "${outputPath.replace(/\\/g, '\\\\')}"

        # Create a temporary text file for the input
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False, encoding='utf-8') as temp_file:
            temp_file.write(text)
            temp_text_path = temp_file.name

        try:
            # Use edge-tts command line with prosody parameters
            cmd = [
                sys.executable, '-m', 'edge_tts',
                '--voice', voice,
                '--file', temp_text_path,
                '--write-media', output_path
            ]

            # Add prosody parameters if they're not default values
            # Use --option=value format for edge-tts command line
            if rate != "+0%":
                cmd.append(f'--rate={rate}')
            if volume != "+0%":
                cmd.append(f'--volume={volume}')
            if pitch != "+0Hz":
                cmd.append(f'--pitch={pitch}')

            # Run the command
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)

            print(json.dumps({'success': True, 'filename': '${fullFilename}'}))

        finally:
            # Clean up temporary file
            if os.path.exists(temp_text_path):
                os.unlink(temp_text_path)

    asyncio.run(generate_audio())

except ImportError:
    print(json.dumps({'success': False, 'error': 'edge-tts library not available'}))
    sys.exit(1)
except subprocess.CalledProcessError as e:
    print(json.dumps({'success': False, 'error': f'edge-tts command failed: {e.stderr}'}))
    sys.exit(1)
except Exception as e:
    print(json.dumps({'success': False, 'error': str(e)}))
    sys.exit(1)
`;

        fs.writeFileSync(tempScript, scriptContent);
        console.log(`[Edge TTS] Written Python script to: ${tempScript}`);

        // Execute the Python script
        console.log(`[Edge TTS] Executing Python script with: ${pythonExecutable} ${tempScript}`);
        console.log(`[Edge TTS] Expected edge-tts command: ${pythonExecutable} -m edge_tts --voice ${voice} --file <temp_file> --write-media ${outputPath}${rate !== '+0%' ? ` --rate=${rate}` : ''}${volume !== '+0%' ? ` --volume=${volume}` : ''}${pitch !== '+0Hz' ? ` --pitch=${pitch}` : ''}`);
        const result = await new Promise((resolve, reject) => {
          const pythonProcess = spawn(pythonExecutable, [tempScript], {
            stdio: ['pipe', 'pipe', 'pipe']
          });
          console.log(`[Edge TTS] Python process spawned with PID: ${pythonProcess.pid}`);

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
              console.error(`[Edge TTS] Python process failed for subtitle ${i}:`);
              console.error(`[Edge TTS] Exit code: ${code}`);
              console.error(`[Edge TTS] Python executable: ${pythonExecutable}`);
              console.error(`[Edge TTS] Script path: ${tempScript}`);
              console.error(`[Edge TTS] Subtitle text: "${subtitle.text}"`);
              console.error(`[Edge TTS] Voice: ${voice}, Rate: ${rate}, Volume: ${volume}, Pitch: ${pitch}`);
              console.error(`[Edge TTS] Output path: ${outputPath}`);
              console.error(`[Edge TTS] STDERR: ${stderr}`);
              console.error(`[Edge TTS] STDOUT: ${stdout}`);
              reject(new Error(`Python process failed with exit code ${code}. STDERR: ${stderr}. STDOUT: ${stdout}`));
              return;
            }

            try {
              const result = JSON.parse(stdout);
              console.log(`[Edge TTS] Successfully parsed result for subtitle ${i}:`, result);
              resolve(result);
            } catch (parseError) {
              console.error(`[Edge TTS] Failed to parse result for subtitle ${i}:`);
              console.error(`[Edge TTS] Parse error: ${parseError.message}`);
              console.error(`[Edge TTS] Raw stdout: ${stdout}`);
              console.error(`[Edge TTS] Raw stderr: ${stderr}`);
              reject(new Error(`Failed to parse result: ${parseError.message}. Raw output: ${stdout}`));
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
          method: 'edge-tts'
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
        console.error(`[Edge TTS] Error generating Edge TTS for subtitle ${i}:`, error);
        console.error(`[Edge TTS] Error stack:`, error.stack);
        console.error(`[Edge TTS] Subtitle text: "${subtitle.text}"`);
        console.error(`[Edge TTS] Voice settings: ${voice}, Rate: ${rate}, Volume: ${volume}, Pitch: ${pitch}`);

        const errorResult = {
          subtitle_id: subtitle.id || i,
          text: subtitle.text,
          success: false,
          error: error.message,
          method: 'edge-tts'
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

    // Clean up old subtitle directories only on explicit full-run request
    const hasGroupedSubtitles = subtitles.some(subtitle => subtitle.original_ids && subtitle.original_ids.length > 0);
    if (hasGroupedSubtitles && settings?.allowCleanup === true) {
      console.log('Edge TTS: Detected grouped subtitles, cleaning up old directories');
      cleanupOldSubtitleDirectories(subtitles);
    } else if (hasGroupedSubtitles) {
      console.log('Edge TTS: Detected grouped subtitles, but skipping cleanup (no allowCleanup flag)');
    }

    // Send completion event
    res.write(`data: ${JSON.stringify({
      status: 'completed',
      results: results
    })}\n\n`);

    res.end();

  } catch (error) {
    console.error('Error in Edge TTS generation:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getVoices,
  generateNarration
};
