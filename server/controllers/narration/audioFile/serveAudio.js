/**
 * Module for serving audio files from narration directories
 */

const path = require('path');
const fs = require('fs');

// Import directory paths
const { REFERENCE_AUDIO_DIR, OUTPUT_AUDIO_DIR, TEMP_AUDIO_DIR } = require('../directoryManager');

// Basic content-type detection (sniff header, fallback to extension)
const getContentType = (filePath) => {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    const header = buf.toString('ascii');
    // WAV starts with RIFF....WAVE
    if (header.startsWith('RIFF') && header.includes('WAVE')) return 'audio/wav';
    // MP3 can start with ID3 or 0xFF 0xFB (frame)
    if (header.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  } catch {}
  const ext = String(path.extname(filePath)).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.ogg') return 'audio/ogg';
  return 'application/octet-stream';
};

// Stream file with Range support for faster playback start
const sendFileWithRange = (req, res, filePath) => {
  try {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const contentType = getContentType(filePath);

    const range = req.headers?.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= fileSize) {
        res.status(416).set({ 'Content-Range': `bytes */${fileSize}` }).end();
        return;
      }
      const chunkSize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
      });
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('error', () => res.status(500).end());
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      });
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => res.status(500).end());
      stream.pipe(res);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

/**
 * Serve audio file from narration directories
 */
const serveAudioFile = (req, res) => {
  try {
    // Get the filename from the request parameters
    const { filename } = req.params;

    console.log(`[DEBUG] Serving audio file: ${filename}`);

    if (!filename) {
      console.error('No filename provided');
      return res.status(400).json({ error: 'No filename provided' });
    }

    // Check if the filename includes a path separator (new structure)
    if (filename.includes(path.sep) || filename.includes('/')) {
      console.log(`[DEBUG] Handling path with separators: ${filename}`);

      // Handle new directory structure (subtitle_id/number.wav)
      // Always use forward slashes for URL paths, then convert to OS-specific path
      const parts = filename.split('/');

      // Log the parts for debugging
      console.log(`[DEBUG] Path parts: ${JSON.stringify(parts)}`);

      // If we have exactly 2 parts (subtitle_ID/number.wav), handle it as our new structure
      if (parts.length === 2 && parts[0].startsWith('subtitle_')) {
        const subtitleDir = parts[0];
        const audioFile = parts[1];

        const outputPath = path.join(OUTPUT_AUDIO_DIR, subtitleDir, audioFile);

        console.log(`[DEBUG] Checking new structure path: ${outputPath}`);

        if (fs.existsSync(outputPath)) {
          console.log(`[DEBUG] Found file at new structure path: ${outputPath}`);
          return sendFileWithRange(req, res, outputPath);
        } else {
          console.log(`[DEBUG] File not found at new structure path: ${outputPath}`);

          // Try alternate extension (.wav <-> .mp3)
          const base = path.parse(audioFile).name;
          const tryExts = ['.wav', '.mp3'];
          for (const ext of tryExts) {
            const alt = path.join(OUTPUT_AUDIO_DIR, subtitleDir, base + ext);
            if (fs.existsSync(alt)) {
              console.log(`[DEBUG] Found by alternate ext: ${alt}`);
              return sendFileWithRange(req, res, alt);
            }
          }

          // Try with a different case (Windows is case-insensitive but URLs might be case-sensitive)
          const files = fs.readdirSync(path.join(OUTPUT_AUDIO_DIR, subtitleDir));
          console.log(`[DEBUG] Files in ${subtitleDir}: ${JSON.stringify(files)}`);

          // Try to find a case-insensitive match
          const matchingFile = files.find(file => file.toLowerCase() === audioFile.toLowerCase());
          if (matchingFile) {
            const caseCorrectedPath = path.join(OUTPUT_AUDIO_DIR, subtitleDir, matchingFile);
            console.log(`[DEBUG] Found case-insensitive match: ${caseCorrectedPath}`);
            return sendFileWithRange(req, res, caseCorrectedPath);
          }
        }
      } else {
        // Handle other path formats
        const normalizedPath = filename.replace(/\//g, path.sep); // Normalize path separators
        const outputPath = path.join(OUTPUT_AUDIO_DIR, normalizedPath);

        console.log(`[DEBUG] Checking alternative path structure: ${outputPath}`);

        if (fs.existsSync(outputPath)) {
          console.log(`[DEBUG] Found file at alternative path: ${outputPath}`);
          return sendFileWithRange(req, res, outputPath);
        } else {
          console.log(`[DEBUG] File not found at alternative path: ${outputPath}`);
        }
      }
    } else {
      // Legacy path handling - check in root directories

      // Check if the file is in the output directory
      const outputPath = path.join(OUTPUT_AUDIO_DIR, filename);
      console.log(`[DEBUG] Checking legacy output path: ${outputPath}`);

      if (fs.existsSync(outputPath)) {
        console.log(`[DEBUG] Found file at legacy output path: ${outputPath}`);
        return sendFileWithRange(req, res, outputPath);
      }

      // Check if the file is in the reference directory
      const referencePath = path.join(REFERENCE_AUDIO_DIR, filename);
      console.log(`[DEBUG] Checking reference path: ${referencePath}`);

      if (fs.existsSync(referencePath)) {
        console.log(`[DEBUG] Found file at reference path: ${referencePath}`);
        return sendFileWithRange(req, res, referencePath);
      }

      // Check if the file is in the temp directory
      const tempPath = path.join(TEMP_AUDIO_DIR, filename);
      console.log(`[DEBUG] Checking temp path: ${tempPath}`);

      if (fs.existsSync(tempPath)) {
        console.log(`[DEBUG] Found file at temp path: ${tempPath}`);
        return sendFileWithRange(req, res, tempPath);
      }

      // If we get here, try to find the file in any subtitle directory
      try {
        const subtitleDirs = fs.readdirSync(OUTPUT_AUDIO_DIR)
          .filter(item => item.startsWith('subtitle_') &&
                  fs.statSync(path.join(OUTPUT_AUDIO_DIR, item)).isDirectory());

        console.log(`[DEBUG] Searching in subtitle directories: ${subtitleDirs.join(', ')}`);

        // Look for a file with the same name in any subtitle directory
        for (const dir of subtitleDirs) {
          const dirPath = path.join(OUTPUT_AUDIO_DIR, dir);
          const files = fs.readdirSync(dirPath);

          // If the filename is a number (like "4.wav"), look for it
          if (/^\d+\.wav$/.test(filename)) {
            if (files.includes(filename)) {
              const foundPath = path.join(dirPath, filename);
              console.log(`[DEBUG] Found file in subtitle directory: ${foundPath}`);
              return sendFileWithRange(req, res, foundPath);
            }
          }
        }
      } catch (err) {
        console.error(`[DEBUG] Error searching subtitle directories: ${err.message}`);
      }
    }

    // If the file is not found in any directory
    console.error(`Audio file not found: ${filename}`);

    // Try to list the contents of the output directory to help with debugging
    try {
      console.log(`[DEBUG] Contents of OUTPUT_AUDIO_DIR (${OUTPUT_AUDIO_DIR}):`);
      const outputDirContents = fs.readdirSync(OUTPUT_AUDIO_DIR);
      console.log(outputDirContents);

      // Check if there are any subtitle directories
      const subtitleDirs = outputDirContents.filter(item =>
        item.startsWith('subtitle_') &&
        fs.statSync(path.join(OUTPUT_AUDIO_DIR, item)).isDirectory()
      );

      if (subtitleDirs.length > 0) {
        console.log(`[DEBUG] Found subtitle directories: ${subtitleDirs.join(', ')}`);

        // Check the contents of the first few subtitle directories
        for (let i = 0; i < Math.min(3, subtitleDirs.length); i++) {
          const dirPath = path.join(OUTPUT_AUDIO_DIR, subtitleDirs[i]);
          console.log(`[DEBUG] Contents of ${dirPath}:`);
          console.log(fs.readdirSync(dirPath));
        }
      }
    } catch (err) {
      console.error(`[DEBUG] Error listing directory contents: ${err.message}`);
    }

    return res.status(404).json({ error: 'Audio file not found' });
  } catch (error) {
    console.error('Error serving audio file:', error);
    return res.status(500).json({ error: `Failed to serve audio file: ${error.message}` });
  }
};

module.exports = {
  serveAudioFile
};
