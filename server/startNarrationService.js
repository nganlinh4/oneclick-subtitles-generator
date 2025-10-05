/**
 * Script to start the F5-TTS narration service and Chatterbox API service
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Import unified port configuration
const { PORTS } = require('./config');

// Import port management
const { trackProcess } = require('./utils/portManager');

// Configuration using unified ports
const NARRATION_PORT = PORTS.NARRATION;
const CHATTERBOX_PORT = PORTS.CHATTERBOX;
const UV_EXECUTABLE = process.env.UV_EXECUTABLE || 'uv';

// Start the Chatterbox API service
function startChatterboxService() {
  try {
    console.log(`🔧 Starting Chatterbox API service on port ${CHATTERBOX_PORT}...`);

    // Check if Chatterbox directory and required files exist
    const chatterboxDir = path.join(path.dirname(__dirname), 'chatterbox-fastapi');
    const chatterboxApiPath = path.join(chatterboxDir, 'start_api.py');
    const chatterboxMainApiPath = path.join(chatterboxDir, 'api.py');

    if (!fs.existsSync(chatterboxDir)) {
      console.warn('⚠️  Chatterbox directory not found. Chatterbox service will not be available.');
      console.warn('   Run the setup script to install Chatterbox: npm run setup:narration');
      return null;
    }

    if (!fs.existsSync(chatterboxApiPath)) {
      console.warn('⚠️  Chatterbox start_api.py not found. Chatterbox service will not be available.');
      console.warn(`   Expected path: ${chatterboxApiPath}`);
      return null;
    }

    if (!fs.existsSync(chatterboxMainApiPath)) {
      console.warn('⚠️  Chatterbox api.py not found. Chatterbox service will not be available.');
      console.warn(`   Expected path: ${chatterboxMainApiPath}`);
      console.warn('   Run the setup script to install Chatterbox: npm run setup:narration');
      return null;
    }

    // Set environment variables for Chatterbox
    const env = {
      ...process.env,
      CHATTERBOX_PORT: CHATTERBOX_PORT,
      CUDA_VISIBLE_DEVICES: '0', // Use same CUDA device as F5-TTS
      PYTORCH_CUDA_ALLOC_CONF: 'max_split_size_mb:512'
    };

    // Start the Chatterbox service using the same pattern as F5-TTS
    // Run from the project root to ensure the virtual environment is found
    const projectRoot = path.dirname(chatterboxDir);
    const startApiPath = path.join('chatterbox-fastapi', 'start_api.py');

    const chatterboxProcess = spawn(UV_EXECUTABLE, [
      'run',
      '--python', '.venv',  // Explicitly use the .venv virtual environment
      '--',
      'python',
      startApiPath,  // Use relative path from project root
      '--host', '0.0.0.0',
      '--port', CHATTERBOX_PORT.toString(),
      '--reload'
    ], {
      env,
      stdio: 'inherit',
      cwd: projectRoot  // Run from project root where .venv is located
    });

    // Handle process events
    chatterboxProcess.on('error', (error) => {
      console.error('❌ Failed to start Chatterbox service:', error);
    });

    chatterboxProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`❌ Chatterbox service exited with code ${code}`);
      } else {
        console.log('✅ Chatterbox service stopped gracefully');
      }
    });

    // Track the Chatterbox process
    if (chatterboxProcess.pid) {
      trackProcess(CHATTERBOX_PORT, chatterboxProcess.pid, 'Chatterbox API');
    }

    console.log(`✅ Chatterbox API service starting...`);
    console.log(`📁 Working directory: ${projectRoot}`);
    console.log(`📁 Script path: ${startApiPath}`);
    console.log(`🌐 Will be available at: http://localhost:${CHATTERBOX_PORT}`);
    console.log(`📖 API documentation: http://localhost:${CHATTERBOX_PORT}/docs`);

    return chatterboxProcess;
  } catch (error) {
    console.error(`❌ Error starting Chatterbox service: ${error.message}`);
    return null;
  }
}

// Start the F5-TTS narration service
function startNarrationService() {


  try {
    // Check if uv is installed
    try {
      require('child_process').execSync(`${UV_EXECUTABLE} --version`, { encoding: 'utf8' });
      console.log(`✅ UV package manager found`);
    } catch (error) {
      console.error(`❌ Error checking uv version: ${error.message}`);
      console.error('   Please install uv: https://astral.sh/uv');
      return null;
    }

    // Set environment variables - force CUDA usage
    const env = {
      ...process.env,
      NARRATION_PORT: NARRATION_PORT,
      CUDA_VISIBLE_DEVICES: '0', // Force use of first CUDA device
      PYTORCH_CUDA_ALLOC_CONF: 'max_split_size_mb:512' // Avoid memory fragmentation issues
    };

    // Create narration directories if they don't exist
    const narrationDir = path.join(path.dirname(__dirname), 'narration');
    const referenceDir = path.join(narrationDir, 'reference');
    const outputDir = path.join(narrationDir, 'output');

    if (!fs.existsSync(narrationDir)) {
      fs.mkdirSync(narrationDir, { recursive: true });

    }

    if (!fs.existsSync(referenceDir)) {
      fs.mkdirSync(referenceDir, { recursive: true });

    }

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });

    }

    // Check for CUDA support
    try {

      // Create a temporary Python script to check CUDA
      const fs = require('fs');
      const os = require('os');
      const tempFile = path.join(os.tmpdir(), 'check_cuda.py');

      const pythonCode = `
import torch
print(f'CUDA available: {torch.cuda.is_available()}')
print(f'CUDA device count: {torch.cuda.device_count() if torch.cuda.is_available() else 0}')
print(f'CUDA device name: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else "N/A"}')
`;

      fs.writeFileSync(tempFile, pythonCode);

      const checkCudaCmd = `${UV_EXECUTABLE} run ${tempFile}`;
      const cudaCheck = require('child_process').execSync(checkCudaCmd, { encoding: 'utf8' });


      // Clean up the temporary file
      try {
        fs.unlinkSync(tempFile);
      } catch (cleanupError) {
        console.warn(`Warning: Unable to delete temporary file: ${cleanupError.message}`);
      }

      // If CUDA is not available, print a warning
      if (!cudaCheck.includes('CUDA available: True')) {
        console.warn('WARNING: CUDA is not available. The narration service will run on CPU, which is much slower.');
        console.warn('Make sure your NVIDIA drivers and CUDA toolkit are properly installed.');
      } else {

      }
    } catch (error) {
      console.warn(`Warning: Unable to check CUDA availability: ${error.message}`);
    }

    // Ensure critical Python runtime deps exist in the shared venv before starting services
    try {
      const { execSync } = require('child_process');
      const ensureCmd = `${UV_EXECUTABLE} pip show --python .venv python-dateutil || ${UV_EXECUTABLE} pip install --python .venv python-dateutil==2.9.0.post0`;
      execSync(ensureCmd, { stdio: 'inherit', cwd: projectRoot });
    } catch (e) {
      console.warn(`Warning: Failed to ensure python-dateutil in .venv: ${e.message}`);
    }

    // Spawn the Python process using uv
    const narrationAppPath = path.join(__dirname, 'narrationApp.py');
    const projectRoot = path.dirname(__dirname);

    const narrationProcess = spawn(UV_EXECUTABLE, [
      'run',
      '--python', '.venv',  // Explicitly use the .venv virtual environment
      '--',
      'python',
      narrationAppPath
    ], {
      env,
      stdio: 'inherit',
      cwd: projectRoot  // Run from project root where .venv is located
    });

    // Handle process events
    narrationProcess.on('error', (error) => {
      console.error('Failed to start narration service:', error);
    });

    narrationProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`Narration service exited with code ${code}`);
      }
    });

    console.log(`✅ F5-TTS narration service started on port ${NARRATION_PORT}`);

    // Track the narration process
    if (narrationProcess.pid) {
      trackProcess(NARRATION_PORT, narrationProcess.pid, 'F5-TTS Narration');
    }

    // Start Chatterbox service
    const chatterboxProcess = startChatterboxService();

    // Return both processes for cleanup
    return {
      narrationProcess,
      chatterboxProcess
    };
  } catch (error) {
    console.error(`❌ Error starting F5-TTS narration service: ${error.message}`);
    return null;
  }
}

module.exports = {
  startNarrationService,
  startChatterboxService,
  NARRATION_PORT,
  CHATTERBOX_PORT
};
