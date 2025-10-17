/**
 * Script to update F5-TTS and Chatterbox packages in the virtual environment using uv
 * Lightweight update script that only updates existing packages, doesn't do full setup
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Import our logging utility
const { Logger } = require('./utils/logger');
const logger = new Logger({
    verbose: process.env.VERBOSE === 'true',
    quiet: process.env.QUIET === 'true'
});

// Define the virtual environment directory
const VENV_DIR = '.venv';
const isWindows = os.platform() === 'win32';
const venvBinDir = isWindows ? 'Scripts' : 'bin';

// Helper function to execute commands with retries
function executeWithRetry(command, options = {}, maxRetries = 3) {
  let retries = 0;
  let lastError = null;

  while (retries < maxRetries) {
    try {
      logger.command(command);
      const env = { ...process.env, UV_HTTP_TIMEOUT: '300', ...options.env }; // 5 minutes timeout
      execSync(command, { stdio: logger.verboseMode ? 'inherit' : 'ignore', env, ...options });
      return true; // Success
    } catch (error) {
      lastError = error;
      retries++;
      if (logger.verboseMode) {
        logger.warning(`Attempt ${retries}/${maxRetries} failed: ${error.message}`);
      }

      if (retries < maxRetries) {
        const waitTime = retries * 2000; // Exponential backoff: 2s, 4s, 6s...
        logger.progress(`Waiting ${waitTime/1000} seconds before retrying...`);
        try {
          execSync(`sleep ${waitTime/1000}`, { stdio: 'ignore' });
        } catch (e) {
          // On Windows, sleep is not available, use a timeout instead
          const startTime = Date.now();
          while (Date.now() - startTime < waitTime) {
            // Wait
          }
        }
      }
    }
  }

  throw lastError || new Error(`Failed after ${maxRetries} attempts`);
}

// Check if virtual environment exists
logger.checking('virtual environment');
if (!fs.existsSync(VENV_DIR)) {
  logger.warning('Virtual environment not found. Narration packages update skipped.');
  logger.info('Run setup-narration.js first to set up the environment.');
  process.exit(0);
}

// Update F5-TTS if installed
logger.checking('F5-TTS package');
try {
  // Check if f5-tts is installed using pip list
  const checkCommand = 'uv pip list --python .venv | findstr /C:"f5-tts"';
  execSync(checkCommand, { stdio: 'ignore' });
  logger.found('F5-TTS is installed');

  // Get current version
  const versionCommand = 'uv pip show --python .venv f5-tts | findstr /C:"Version:"';
  const versionOutput = execSync(versionCommand, { encoding: 'utf8' }).trim();
  const currentVersion = versionOutput.split(':')[1].trim();

  // Check if f5-tts is outdated
  const outdatedCommand = 'uv pip list --python .venv --outdated | findstr /C:"f5-tts"';
  let isOutdated = false;
  try {
    execSync(outdatedCommand, { stdio: 'ignore' });
    isOutdated = true;
  } catch (e) {
    // Not in outdated list, so it's up to date
    isOutdated = false;
  }

  if (!isOutdated) {
    logger.success(`F5-TTS is already up to date (${currentVersion})`);
  } else {
    // Update F5-TTS (preserve working PyTorch versions)
    logger.progress(`Updating F5-TTS from ${currentVersion} to latest version`);
    try {
      executeWithRetry('uv pip install --python .venv --upgrade f5-tts');

      // Get new version
      const newVersionOutput = execSync(versionCommand, { encoding: 'utf8' }).trim();
      const newVersion = newVersionOutput.split(':')[1].trim();

      logger.success(`F5-TTS updated: ${currentVersion} → ${newVersion}`);
    } catch (error) {
      logger.warning(`F5-TTS update failed: ${error.message}`);
      if (error.message.includes('Access is denied') || error.message.includes('os error 5')) {
        logger.warning('F5-TTS update skipped - packages appear to be in use by running service');
        logger.info('Restart the application to apply updates');
      } else {
        logger.warning('F5-TTS update failed with unknown error');
      }
    }
  }
} catch (error) {
  logger.info('F5-TTS not found or not installed. Skipping update.');
}

// Update Chatterbox if installed
logger.checking('Chatterbox package');
try {
  // Check if chatterbox-tts is installed using pip list
  const checkCommand = 'uv pip list --python .venv | findstr /C:"chatterbox-tts"';
  execSync(checkCommand, { stdio: 'ignore' });
  logger.found('Chatterbox is installed');

  // Get current version
  const versionCommand = 'uv pip show --python .venv chatterbox-tts | findstr /C:"Version:"';
  const versionOutput = execSync(versionCommand, { encoding: 'utf8' }).trim();
  const currentVersion = versionOutput.split(':')[1].trim();

  // Check if chatterbox-tts is outdated
  const outdatedCommand = 'uv pip list --python .venv --outdated | findstr /C:"chatterbox-tts"';
  let isOutdated = false;
  try {
    execSync(outdatedCommand, { stdio: 'ignore' });
    isOutdated = true;
  } catch (e) {
    // Not in outdated list, so it's up to date
    isOutdated = false;
  }

  if (!isOutdated) {
    logger.success(`Chatterbox is already up to date (${currentVersion})`);
  } else {
    // Update Chatterbox
    logger.progress(`Updating Chatterbox from ${currentVersion} to latest version`);
    try {
      executeWithRetry('uv pip install --python .venv --upgrade chatterbox-tts');

      // Get new version
      const newVersionOutput = execSync(versionCommand, { encoding: 'utf8' }).trim();
      const newVersion = newVersionOutput.split(':')[1].trim();

      logger.success(`Chatterbox updated: ${currentVersion} → ${newVersion}`);
    } catch (error) {
      if (error.message.includes('Access is denied') || error.message.includes('os error 5')) {
        logger.warning('Chatterbox update skipped - packages appear to be in use by running service');
        logger.info('Restart the application to apply updates');
      } else {
        throw error; // Re-throw other errors
      }
    }
  }
} catch (error) {
  logger.info('Chatterbox not found or not installed. Skipping update.');
}

logger.newLine();
logger.success('Narration packages update check completed!');
logger.info('F5-TTS and Chatterbox packages checked for updates.');
logger.info('If packages were in use, restart the application to apply any pending updates.');
logger.info('If you need to install them initially, run: npm run setup:narration:uv');

// Safeguard: Ensure PyTorch versions remain compatible
logger.checking('PyTorch version compatibility');
try {
  // Check PyTorch version without assert to avoid shell escaping issues
  const torchCheckCmd = 'uv run --python .venv -- python -c "import torch; print(torch.__version__)"';
  const versionOutput = execSync(torchCheckCmd, { encoding: 'utf8', stdio: 'pipe' }).trim();

  if (versionOutput.startsWith('2.5.1')) {
    logger.success('PyTorch version is compatible');
  } else {
    throw new Error(`PyTorch version ${versionOutput} is not compatible`);
  }
} catch (error) {
  logger.warning('PyTorch version compatibility check failed');
  logger.info('Reinstalling compatible PyTorch versions...');
  try {
    executeWithRetry('uv pip install --python .venv torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --force-reinstall');
    logger.success('PyTorch versions restored to compatible versions');
  } catch (fixError) {
    logger.warning(`Could not restore PyTorch versions: ${fixError.message}`);
  }
}