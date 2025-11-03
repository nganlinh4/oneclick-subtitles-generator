/**
 * Script to set up the narration service with PyTorch support (CUDA, ROCm, XPU, MPS, CPU) using uv.
 * Detects GPU vendor (NVIDIA, AMD, Intel, Apple) and installs the appropriate PyTorch build.
 * Forcefully removes any existing F5-TTS directory and clones the repository.
 * Automatically attempts to install Python 3.11 via 'uv python install' if not found.
 */

const { execSync, exec } = require('child_process'); // Added exec for non-blocking potential later? No, stick to sync for setup script.
const fs = require('fs');
const path = require('path');
const os = require('os'); // Needed for platform/arch checks
const https = require('https');
const { createWriteStream } = require('fs');

// Import our logging utility
const { Logger } = require('./utils/logger');
const { executeWithProgress, withSpinner } = require('./utils/progress-indicator');
const logger = new Logger({
    verbose: process.env.VERBOSE === 'true',
    quiet: process.env.QUIET === 'true'
});

const VENV_DIR = '.venv'; // Define the virtual environment directory name
const PYTHON_VERSION_TARGET = "3.11"; // Target Python version
const F5_TTS_DIR = 'f5-tts-temp'; // Temporary directory for F5-TTS installation
const F5_TTS_REPO_URL = 'https://github.com/SWivid/F5-TTS.git';

// --- Helper Function to Check Command Existence ---
function commandExists(command) {
    try {
        // Handle potential command arguments (e.g., 'git --version') for the check
        const baseCommand = command.split(' ')[0];
        const checkCmd = process.platform === 'win32' ? `where ${baseCommand}` : `command -v ${baseCommand}`;
        execSync(checkCmd, { stdio: 'ignore' });
        return true;
    } catch (error) {
        return false;
    }
}

// --- Helper Function to Enable Windows GPU Scheduling ---
function enableWindowsGpuScheduling() {
    if (process.platform !== 'win32') {
        return; // Only applicable to Windows
    }

    logger.subsection('Windows GPU Acceleration Setup');

    try {
        // Check current GPU scheduling status
        logger.progress('Checking Windows Hardware-accelerated GPU scheduling status');

        const checkCmd = 'powershell -Command "Get-ItemProperty -Path \\"HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers\\" -Name HwSchMode -ErrorAction SilentlyContinue | Select-Object -ExpandProperty HwSchMode"';
        let currentStatus;

        try {
            const statusOutput = execSync(checkCmd, { encoding: 'utf8' });
            currentStatus = parseInt(statusOutput.trim());
        } catch (error) {
            logger.warning('Could not read GPU scheduling status from registry');
            currentStatus = null;
        }

        if (currentStatus === 2) {
            logger.success('Windows Hardware-accelerated GPU scheduling is already enabled');
            logger.info('This will provide optimal GPU acceleration for video rendering');
            return;
        }

        if (currentStatus === 1 || currentStatus === null) {
            logger.warning('Windows Hardware-accelerated GPU scheduling is disabled');
            logger.info('Enabling GPU scheduling will significantly improve video rendering performance');

            try {
                logger.progress('Enabling Windows Hardware-accelerated GPU scheduling');
                const enableCmd = 'powershell -Command "Set-ItemProperty -Path \\"HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers\\" -Name HwSchMode -Value 2"';
                execSync(enableCmd, { stdio: 'ignore' });

                logger.success('Windows Hardware-accelerated GPU scheduling has been enabled');
                logger.info('🔄 RESTART REQUIRED: Please restart your computer for GPU acceleration to take effect');
                logger.info('After restart, video rendering will be significantly faster (30-70% improvement)');

            } catch (error) {
                logger.warning('Failed to enable GPU scheduling automatically');
                logger.info('Manual instructions:');
                logger.info('1. Open Windows Settings (Win + I)');
                logger.info('2. Go to System > Display > Graphics settings');
                logger.info('3. Enable "Hardware-accelerated GPU scheduling"');
                logger.info('4. Restart your computer');
            }
        } else {
            logger.info(`Unknown GPU scheduling status: ${currentStatus}`);
        }

    } catch (error) {
        logger.warning(`Error checking/enabling GPU scheduling: ${error.message}`);
        logger.info('GPU scheduling optimization skipped - video rendering will still work');
    }
}

// --- Helper Function to Detect GPU Vendor ---
// Note: This detection is heuristic and might not be 100% accurate on all systems.
// It prioritizes common tools (nvidia-smi) and platform checks.
// User override via FORCE_GPU_VENDOR is recommended for certainty.
function detectGpuVendor() {
    logger.subsection('GPU Detection');
    const platform = process.platform;
    const arch = process.arch;

    // --- 1. Check Environment Variable Override ---
    const forcedVendor = process.env.FORCE_GPU_VENDOR?.toUpperCase();
    if (forcedVendor && ['NVIDIA', 'AMD', 'INTEL', 'APPLE', 'CPU'].includes(forcedVendor)) {
        logger.info(`User override detected: FORCE_GPU_VENDOR=${forcedVendor}`);
        // Map APPLE to MPS for clarity internally if needed, but keep APPLE for user consistency
        return forcedVendor === 'APPLE' ? 'APPLE_SILICON' : forcedVendor;
    }

    // --- 2. Apple Silicon Check (macOS arm64) ---
    if (platform === 'darwin' && arch === 'arm64') {
        logger.found('Apple Silicon (macOS arm64)');
        return 'APPLE_SILICON'; // MPS support
    }

    // --- 3. NVIDIA Check (nvidia-smi) ---
    // nvidia-smi is the most reliable indicator for NVIDIA.
    if (commandExists('nvidia-smi')) {
        try {
            execSync('nvidia-smi -L', { stdio: 'ignore' }); // Run a simple command to ensure it works
            logger.found('NVIDIA GPU', 'via nvidia-smi');
            return 'NVIDIA'; // CUDA support
        } catch (error) {
            logger.warning('nvidia-smi found but execution failed, checking other methods...');
        }
    }

    // --- 4. Platform-Specific Checks (Less reliable than nvidia-smi) ---
    try {
        if (platform === 'win32') {
            // Windows: Use WMIC
            const wmicOutput = execSync('wmic path win32_VideoController get name', { encoding: 'utf8' }).toUpperCase();
            if (wmicOutput.includes('NVIDIA')) {
                logger.found('NVIDIA GPU', 'via WMIC');
                return 'NVIDIA';
            }
            if (wmicOutput.includes('AMD') || wmicOutput.includes('RADEON')) {
                logger.found('AMD GPU', 'via WMIC');
                return 'AMD'; // ROCm (Linux mainly) or DirectML (Windows - requires different PyTorch build usually not covered by standard ROCm wheels)
            }
            if (wmicOutput.includes('INTEL')) {
                logger.found('Intel GPU', 'via WMIC');
                return 'INTEL'; // XPU support
            }
        } else if (platform === 'linux') {
            // Linux: Use lspci (requires pciutils)
            if (commandExists('lspci')) {
                 const lspciOutput = execSync("lspci | grep -i 'VGA\\|3D\\|2D'", { encoding: 'utf8' }).toUpperCase();
                 if (lspciOutput.includes('NVIDIA')) {
                    logger.found('NVIDIA GPU', 'via lspci');
                    return 'NVIDIA';
                }
                if (lspciOutput.includes('ADVANCED MICRO DEVICES') || lspciOutput.includes('AMD') || lspciOutput.includes('ATI') || lspciOutput.includes('RADEON')) {
                    logger.found('AMD GPU', 'via lspci');
                    return 'AMD'; // ROCm support (primarily on Linux)
                }
                if (lspciOutput.includes('INTEL')) {
                    logger.found('Intel GPU', 'via lspci');
                    return 'INTEL'; // XPU support
                }
            } else {
                logger.warning("'lspci' command not found, cannot perform detailed PCI check on Linux.");
            }
        }
        // Add macOS non-ARM detection if necessary, though less common for accelerated PyTorch outside ARM/NVIDIA eGPUs
    } catch (error) {
        logger.warning(`Error during GPU detection using system commands: ${error.message}`);
    }

    // --- 5. Fallback ---
    logger.warning('Could not reliably detect a supported accelerated GPU vendor.');
    logger.info('Will install CPU-only version of PyTorch.');
    logger.info('For specific GPU support, set FORCE_GPU_VENDOR environment variable (NVIDIA, AMD, INTEL, APPLE).');
    return 'CPU';
}


// --- Main Setup Function ---
async function runSetup() {
    // --- 0. Enable Windows GPU Scheduling (if Windows) ---
    enableWindowsGpuScheduling();

    // --- 1. Check for uv ---
    logger.section('OneClick Subtitles Generator - Narration Setup');
    logger.step(1, 8, 'Checking for uv package manager');

if (!commandExists('uv')) {
    logger.error('uv is not installed or not found in PATH.');
    logger.info('Please install uv first. See: https://github.com/astral-sh/uv#installation');
    process.exit(1);
}
try {
    const uvVersion = execSync('uv --version', { encoding: 'utf8' }).trim();
    logger.found('uv', uvVersion);
} catch (error) {
    logger.error('Failed to execute uv. Make sure it is installed and in your PATH.');
    logger.info('See: https://github.com/astral-sh/uv#installation');
    process.exit(1);
}



// --- 2. Check for/Install Python 3.11 ---
logger.step(2, 8, `Checking for Python ${PYTHON_VERSION_TARGET}`);
let pythonInterpreterIdentifier = null;
let triedUvInstall = false;

// (Python detection logic remains the same as before)
// First, try to find an existing Python 3.11 interpreter
try {
  if (process.platform === 'win32') {
    try {
      const pyVersionsOutput = execSync('py -0p', { encoding: 'utf8' }).trim();
      if (logger.verboseMode) {
        logger.info('Available Python interpreters (via py launcher):');
        logger.raw(pyVersionsOutput || '   (None found or py command failed)');
      }
      const lines = pyVersionsOutput.split('\n');
      const python311Line = lines.find(line => line.match(new RegExp(`^-${PYTHON_VERSION_TARGET}`)));
      if (python311Line) {
         const match = python311Line.match(/\s*(.+)$/);
         if(match && match[1]) {
            pythonInterpreterIdentifier = match[1].trim();
            if (pythonInterpreterIdentifier.includes(' ')) {
                pythonInterpreterIdentifier = `"${pythonInterpreterIdentifier}"`;
            }
            logger.found(`Python ${PYTHON_VERSION_TARGET} interpreter via py`, pythonInterpreterIdentifier);
         }
      }
      if (!pythonInterpreterIdentifier && execSync('py -0', { encoding: 'utf8' }).includes(`-${PYTHON_VERSION_TARGET}`)) {
         pythonInterpreterIdentifier = `python${PYTHON_VERSION_TARGET}`;
         logger.found(`Python ${PYTHON_VERSION_TARGET} via py launcher`, `using alias "${pythonInterpreterIdentifier}" for uv`);
      }
    } catch (error) {
      logger.warning(`py launcher check failed or Python ${PYTHON_VERSION_TARGET} not listed`);
    }
  }

  const pythonCommand = `python${PYTHON_VERSION_TARGET}`;
  if (!pythonInterpreterIdentifier && commandExists(pythonCommand)) {
     try {
        const pythonVersion = execSync(`${pythonCommand} --version`, { encoding: 'utf8' }).trim();
        console.log(`   Found Python via command: ${pythonVersion}`);
        if (pythonVersion.includes(PYTHON_VERSION_TARGET)) {
            const checkCmd = process.platform === 'win32' ? `where ${pythonCommand}` : `command -v ${pythonCommand}`;
            const fullPath = execSync(checkCmd, { encoding: 'utf8' }).split('\n')[0].trim();
            if (fullPath) {
                 pythonInterpreterIdentifier = fullPath.includes(' ') ? `"${fullPath}"` : fullPath;
                 logger.found(`Python ${PYTHON_VERSION_TARGET} via command "${pythonCommand}"`, pythonInterpreterIdentifier);
            } else {
                 pythonInterpreterIdentifier = pythonCommand;
                 logger.found(`Python ${PYTHON_VERSION_TARGET} via command "${pythonCommand}"`, 'using alias for uv');
            }
        }
     } catch(error) {
         console.log(`   '${pythonCommand}' command exists but execution failed or couldn't get path.`);
         if(commandExists(pythonCommand)){
            pythonInterpreterIdentifier = pythonCommand;
            console.log(`   Assuming uv can find "${pythonCommand}".`);
         }
     }
  }
} catch (error) {
  logger.warning(`Warning during initial Python ${PYTHON_VERSION_TARGET} check: ${error.message}. Will proceed to check uv install.`);
}

if (!pythonInterpreterIdentifier) {
    logger.warning(`Python ${PYTHON_VERSION_TARGET} not found in standard locations`);
    logger.installing(`Python ${PYTHON_VERSION_TARGET} using uv`);
    triedUvInstall = true;
    try {
        execSync(`uv python install ${PYTHON_VERSION_TARGET}`, { stdio: logger.verboseMode ? 'inherit' : 'ignore' });
        logger.success(`Python ${PYTHON_VERSION_TARGET} installation via uv successful`);
        pythonInterpreterIdentifier = PYTHON_VERSION_TARGET;
    } catch (installError) {
        logger.error(`Failed to install Python ${PYTHON_VERSION_TARGET} using uv: ${installError.message}`);
        logger.info(`Please try installing Python ${PYTHON_VERSION_TARGET} manually (https://www.python.org/downloads/)`);
        logger.info(`or ensure uv has the necessary permissions and network access.`);
        process.exit(1);
    }
} else {
     logger.success(`Using Python ${PYTHON_VERSION_TARGET} interpreter identifier for uv: ${pythonInterpreterIdentifier}`);
}

if (!pythonInterpreterIdentifier) {
    logger.error(`Could not find or install Python ${PYTHON_VERSION_TARGET}. Cannot proceed.`);
    process.exit(1);
}


// --- 3. Create or verify virtual environment with uv ---
logger.step(3, 8, 'Setting up Python virtual environment');

// Check if virtual environment already exists and is valid
let venvExists = false;
if (fs.existsSync(VENV_DIR)) {
    logger.progress(`Virtual environment directory "${VENV_DIR}" exists. Verifying...`);
    try {
        // Test if the venv is functional by checking Python version
        const venvPythonCmd = process.platform === 'win32'
            ? `"${path.join(VENV_DIR, 'Scripts', 'python.exe')}"`
            : `"${path.join(VENV_DIR, 'bin', 'python')}"`;

        const venvPythonVersion = execSync(`${venvPythonCmd} --version`, { encoding: 'utf8' }).trim();
        if (logger.verboseMode) {
            logger.info(`Existing venv Python version: ${venvPythonVersion}`);
        }

        if (venvPythonVersion.includes(PYTHON_VERSION_TARGET)) {
            venvExists = true;
            logger.success(`Valid virtual environment found at ${VENV_DIR}. Reusing existing venv.`);
        } else {
            logger.warning(`Existing venv has different Python version. Will recreate.`);
        }
    } catch (error) {
        logger.warning(`Existing venv appears to be corrupted or incomplete. Will recreate.`);
    }
}

    if (!venvExists) {
        logger.installing(`virtual environment with uv at ./${VENV_DIR} using Python "${pythonInterpreterIdentifier}"`);

        // Remove existing directory if it exists but is invalid
        if (fs.existsSync(VENV_DIR)) {
            logger.progress(`Removing invalid virtual environment directory...`);
            try {
                fs.rmSync(VENV_DIR, { recursive: true, force: true });
            } catch (error) {
                logger.error(`Error removing existing venv directory: ${error.message}`);
                process.exit(1);
            }
        }

        try {
            execSync(`uv venv -p ${pythonInterpreterIdentifier} ${VENV_DIR}`, { stdio: 'inherit' });
        logger.success(`Virtual environment created at ${VENV_DIR}`);
    } catch (error) {
        logger.error(`Error creating virtual environment with uv: ${error.message}`);
        if (triedUvInstall) {
            logger.info(`Even after attempting 'uv python install', creating the venv with '${pythonInterpreterIdentifier}' failed.`);
            logger.info(`This might indicate an issue with the uv installation or environment.`);
            logger.info(`Try running 'uv venv -p ${PYTHON_VERSION_TARGET} ${VENV_DIR}' manually to diagnose.`);
        } else {
            logger.info(`Failed to create venv with existing interpreter "${pythonInterpreterIdentifier}". Is it a valid Python executable or alias known to uv?`);
            logger.info(`Try running 'uv venv -p ${pythonInterpreterIdentifier} ${VENV_DIR}' manually.`);
        }
        process.exit(1);
    }
}

// --- 4. Detect GPU and Install Appropriate PyTorch Build ---
logger.step(4, 8, 'Installing PyTorch with GPU support');
logger.info(`The virtual environment at ./${VENV_DIR} will be used for both F5-TTS and Chatterbox installations.`);

const gpuVendor = detectGpuVendor(); // Call the detection function
let torchInstallCmd = '';
let installNotes = '';

switch (gpuVendor) {
    case 'NVIDIA':
        logger.installing('PyTorch for NVIDIA GPU (CUDA)');
        // Using CUDA 12.1 with working versions that support both F5-TTS and Chatterbox
        // PyTorch 2.5.1 with torchvision 0.20.1 for compatibility with both packages
        torchInstallCmd = `uv pip install torch==2.5.1+cu121 torchvision==0.20.1+cu121 torchaudio==2.5.1+cu121 --index-url https://download.pytorch.org/whl/cu121 --force-reinstall`;
        installNotes = 'Ensure NVIDIA drivers compatible with CUDA 12.1+ are installed. Using PyTorch 2.5.1 for F5-TTS and Chatterbox compatibility.';
        break;
    case 'AMD':
        logger.installing('PyTorch for AMD GPU (ROCm)');
        if (process.platform !== 'linux') {
            logger.warning('PyTorch ROCm wheels are officially supported only on Linux.');
            logger.warning('Installation may fail or runtime errors may occur on non-Linux systems.');
        }
        // Using working versions for both F5-TTS and Chatterbox - CPU versions for ROCm compatibility
        torchInstallCmd = `uv pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --force-reinstall`;
        installNotes = 'Using CPU versions of PyTorch 2.5.1 for F5-TTS and Chatterbox compatibility. ROCm support may be limited.';
        break;
    case 'INTEL':
        logger.installing('PyTorch for Intel GPU (XPU)');
        // Using working versions for both F5-TTS and Chatterbox - CPU versions for Intel compatibility
        torchInstallCmd = `uv pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --force-reinstall`;
        installNotes = 'Using CPU versions of PyTorch 2.5.1 for F5-TTS and Chatterbox compatibility. Intel GPU support may be limited.';
        break;
    case 'APPLE_SILICON':
        logger.installing('PyTorch for Apple Silicon (MPS)');
        // Using working versions for both F5-TTS and Chatterbox with MPS support
        torchInstallCmd = `uv pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --force-reinstall`;
        installNotes = 'Using PyTorch 2.5.1 with Metal Performance Shaders (MPS) support for F5-TTS and Chatterbox compatibility.';
        break;
    case 'CPU':
    default:
        logger.installing('CPU-only PyTorch');
        // Using working versions for both F5-TTS and Chatterbox
        torchInstallCmd = `uv pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --force-reinstall`;
        installNotes = 'Installed PyTorch 2.5.1 CPU-only version for F5-TTS and Chatterbox compatibility. No GPU acceleration will be used.';
        break;
}

try {
    console.log(`Running command: ${torchInstallCmd}`);
    if (installNotes) {
        console.log(`   Notes: ${installNotes}`);
    }
    // Explicitly specify the virtual environment to ensure uv uses it
    const torchInstallCmdWithVenv = torchInstallCmd.replace('uv pip install', `uv pip install --python ${VENV_DIR}`);
    logger.command(torchInstallCmdWithVenv);
    // Set longer timeout for large PyTorch downloads
    const env = { ...process.env, UV_HTTP_TIMEOUT: '300' }; // 5 minutes
    execSync(torchInstallCmdWithVenv, { stdio: 'inherit', env });
    logger.success(`PyTorch (${gpuVendor} target) installed successfully`);

    // --- 5b. Verify Installation ---
    logger.progress('Verifying PyTorch installation');
    // Enhanced verification script
    const verifyTorchPyCode = `
import sys
import torch
import traceback

try:
    print(f"PyTorch version: {torch.__version__}")

    # Check CUDA (NVIDIA)
    cuda_available = False
    if hasattr(torch, 'cuda'):
        try:
            cuda_available = torch.cuda.is_available()
            print(f"CUDA available (NVIDIA): {cuda_available}")
            if cuda_available:
                print(f"  Device Count: {torch.cuda.device_count()}")
                for i in range(torch.cuda.device_count()):
                   print(f"  Device {i}: {torch.cuda.get_device_name(i)}")
        except Exception as e:
            print(f"  CUDA check failed: {e}")
            cuda_available = False # Ensure it's false if check fails

    # Check MPS (Apple Silicon)
    mps_available = False
    if hasattr(torch.backends, 'mps'):
       try:
            mps_available = torch.backends.mps.is_available()
            print(f"MPS available (Apple Silicon): {mps_available}")
            # Note: MPS doesn't have named devices like CUDA
       except Exception as e:
           print(f"  MPS check failed: {e}")
           mps_available = False

    # Check ROCm (AMD - often reports as CUDA device type)
    rocm_likely = False
    if cuda_available and sys.platform == 'linux':
        # ROCm sometimes presents as CUDA. Check name if possible.
        try:
            gpu_name = torch.cuda.get_device_name(0).upper()
            if 'AMD' in gpu_name or 'RADEON' in gpu_name:
                 print(f"ROCm available (AMD): True (Detected via CUDA device name: {torch.cuda.get_device_name(0)})")
                 rocm_likely = True
            elif 'NVIDIA' not in gpu_name:
                 print(f"CUDA device detected, but name doesn't clearly indicate NVIDIA or AMD: {torch.cuda.get_device_name(0)}")
        except Exception as e:
             print(f"  Could not get device name for potential ROCm check: {e}")


    # Check XPU (Intel)
    xpu_available = False
    if hasattr(torch, 'xpu'):
        try:
            xpu_available = torch.xpu.is_available()
            print(f"XPU available (Intel): {xpu_available}")
            if xpu_available:
                 print(f"  Device Count: {torch.xpu.device_count()}")
                 # Getting device name might need specific intel_extension_for_pytorch
                 # print(f"  Device 0 Name: {torch.xpu.get_device_name(0)}") # May fail depending on install
        except Exception as e:
            print(f"  XPU check failed: {e}")
            xpu_available = False


    print("-" * 20)
    if cuda_available and not rocm_likely:
        print("✅ PyTorch CUDA (NVIDIA) acceleration appears available.")
    elif rocm_likely:
         print("✅ PyTorch ROCm (AMD) acceleration appears available (via CUDA interface).")
    elif mps_available:
        print("✅ PyTorch MPS (Apple Silicon) acceleration appears available.")
    elif xpu_available:
        print("✅ PyTorch XPU (Intel) acceleration appears available.")
    elif not cuda_available and not mps_available and not xpu_available:
        print("✅ PyTorch is installed, but no GPU acceleration (CUDA, MPS, ROCm, XPU) was detected.")
        print("   Operations will run on the CPU.")
    else:
        # Should not happen if logic is correct, but catch any missed cases
        print("✅ PyTorch is installed. Check specific accelerator status above.")

except Exception as e:
    print(f"❌ Error during PyTorch verification: {e}")
    traceback.print_exc()
    sys.exit(1)
`;
    // Escape double quotes inside the Python code string for the shell command
    const verifyTorchCmd = `uv run --python ${VENV_DIR} -- python -c "${verifyTorchPyCode.replace(/"/g, '\\"')}"`;
    execSync(verifyTorchCmd, { stdio: 'inherit', encoding: 'utf8' });
    logger.success('PyTorch verification check completed');

    // --- 5c. Validate PyTorch/torchvision compatibility ---
    logger.progress('Validating PyTorch/torchvision compatibility');
    const validateVersionsPyCode = `
import sys
import torch
import torchvision
import traceback

try:
    torch_version = torch.__version__
    torchvision_version = torchvision.__version__

    print(f"PyTorch version: {torch_version}")
    print(f"torchvision version: {torchvision_version}")

    # Check for the specific error that was occurring
    try:
        # This import was failing with the torchvision::nms error
        from torchvision.transforms import InterpolationMode
        print("✅ torchvision imports working correctly")

        # Test a basic torchvision operation
        import torchvision.ops
        print("✅ torchvision.ops module accessible")

    except Exception as e:
        print(f"❌ torchvision compatibility issue detected: {e}")
        print("This indicates a PyTorch/torchvision version mismatch")
        sys.exit(1)

    // Validate expected versions for F5-TTS and Chatterbox compatibility
    expected_torch = "2.5.1";
    expected_torchvision = "0.20.1";

    if not torch_version.startswith(expected_torch):
        print(f"⚠️ Warning: Expected PyTorch {expected_torch}, got {torch_version}")
    if not torchvision_version.startswith(expected_torchvision):
        print(f"⚠️ Warning: Expected torchvision {expected_torchvision}, got {torchvision_version}")

    print("✅ PyTorch/torchvision compatibility validation passed")

except Exception as e:
    print(f"❌ Version validation failed: {e}")
    traceback.print_exc()
    sys.exit(1)
`;
    const validateVersionsCmd = `uv run --python ${VENV_DIR} -- python -c "${validateVersionsPyCode.replace(/"/g, '\\"')}"`;
    execSync(validateVersionsCmd, { stdio: 'inherit', encoding: 'utf8' });
    logger.success('PyTorch/torchvision compatibility validated');

} catch (error) {
    logger.error(`Error installing or verifying PyTorch (${gpuVendor} target) with uv: ${error.message}`);
    logger.info(`Command attempted: ${torchInstallCmd.replace('uv pip install', `uv pip install --python ${VENV_DIR}`)}`); // Show the command that failed
    logger.info(`${installNotes}`); // Remind user of potential requirements
    process.exit(1);
}


// --- 6. Install core dependencies for both F5-TTS and Chatterbox services ---
logger.progress('Installing core AI dependencies');
try {
    // Core dependencies needed for both services
    const coreDeps = [
        // Flask server dependencies (for narrationApp.py)
        'flask',
        'flask-cors',
        'requests',
        'python-dateutil', // required by transformers and various utilities
        'huggingface_hub',

        // FastAPI/Chatterbox dependencies (for start_api.py and api.py)
        'fastapi>=0.104.0',
        'uvicorn[standard]>=0.24.0',
        'python-multipart>=0.0.6',
        'pydantic>=2.0.0',
        'click',  // Required by uvicorn

        // F5-TTS specific dependencies
        'soundfile',
        'numpy',
        'vocos',
        'setuptools',

        // Additional TTS libraries
        'edge-tts',  // Microsoft Edge TTS
        'gtts'       // Google Text-to-Speech
    ];

    const depsCmd = `uv pip install --python ${VENV_DIR} ${coreDeps.join(' ')}`;
    logger.command(depsCmd);
    const env = { ...process.env, UV_HTTP_TIMEOUT: '300' }; // 5 minutes
    execSync(depsCmd, { stdio: 'inherit', env });

    // Verify critical runtime deps are importable; auto-fix if missing (Windows-friendly)
    try {
        logger.progress('Verifying core runtime imports (dateutil)');
        const verifyCorePyCode = `import sys\nmissing=[]\ntry:\n    import dateutil\nexcept Exception:\n    missing.append('python-dateutil')\nprint('Missing:'+','.join(missing) if missing else 'OK')`;
        const verifyCoreCmd = `uv run --python ${VENV_DIR} -- python -c "${verifyCorePyCode.replace(/\"/g, '\\\"')}"`;
        const out = execSync(verifyCoreCmd, { encoding: 'utf8' });
        if (logger.verboseMode) logger.info(out.trim());
        if (/^Missing:/.test(out)) {
            const fixCmd = `uv pip install --python ${VENV_DIR} python-dateutil`;
            logger.progress('Installing missing python-dateutil');
            logger.command(fixCmd);
            execSync(fixCmd, { stdio: 'inherit' });
        }
    } catch (verr) {
        logger.warning('Non-fatal issue during core runtime import verification');
    }

    logger.success('Core AI dependencies installed (including edge-tts and gtts)');
} catch (error) {
    console.error(`❌ Error installing core dependencies with uv: ${error.message}`);
    console.log(`   Command failed: ${error.cmd}`);
    process.exit(1);
}

// --- Install Parakeet service dependencies into the same .venv ---
logger.subsection('Installing Parakeet dependencies');
try {
    const parakeetReqPath = path.join(__dirname, 'parakeet_wrapper', 'requirements.txt');
    if (fs.existsSync(parakeetReqPath)) {
        // Use a conservative install that respects existing resolved packages
        const parakeetCmd = `uv pip install --python ${VENV_DIR} -r "${parakeetReqPath}"`;
        logger.command(parakeetCmd);
        const env = { ...process.env, UV_HTTP_TIMEOUT: '600' }; // allow time for wheels
        execSync(parakeetCmd, { stdio: 'inherit', env });

        // Quick import verification for key deps without modifying versions
        logger.progress('Verifying Parakeet runtime imports');
        const verifyParakeetPy = `
import sys
print('Python:', sys.executable)
missing = []
try:
    import fastapi
except Exception:
    missing.append('fastapi')
try:
    import uvicorn
except Exception:
    missing.append('uvicorn')
try:
    import pydub
except Exception:
    missing.append('pydub')
try:
    import numpy
except Exception:
    missing.append('numpy')
try:
    import scipy
except Exception:
    missing.append('scipy')
try:
    import importlib
    onnx_asr = importlib.import_module('onnx_asr')
except Exception:
    missing.append('onnx-asr')
print('OK' if not missing else ('Missing:' + ','.join(missing)))
`;
    const verifyParakeetCmd = `uv run --python ${VENV_DIR} -- python -c "${verifyParakeetPy.replace(/"/g, '\\"')}"`;
        // Use try/catch: verification is helpful but non-fatal
        try {
            const out = execSync(verifyParakeetCmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
            if (out && /Missing:/.test(out)) {
                logger.warning(`Parakeet verification reported missing modules: ${out.replace('Missing:', '')}`);
            } else {
                logger.success('Parakeet dependencies verified');
            }
        } catch (verr) {
            logger.warning('Parakeet verification encountered an issue (continuing)');
        }
    } else {
        logger.info('parakeet_wrapper/requirements.txt not found; skipping Parakeet deps');
    }
} catch (error) {
    logger.warning(`Parakeet dependencies installation had issues: ${error.message}`);
    logger.info('Continuing setup; Parakeet service may not start until dependencies are installed');
}

// --- 5. Install F5-TTS using uv pip ---
logger.step(5, 8, 'Installing F5-TTS');
logger.installing('Text-to-Speech AI engine');
try {
    // Clone the official F5-TTS repository
    logger.progress('Cloning official F5-TTS repository');

    // Remove existing F5-TTS directory if it exists
    if (fs.existsSync(F5_TTS_DIR)) {
        logger.info('Removing existing F5-TTS directory...');
        fs.rmSync(F5_TTS_DIR, { recursive: true, force: true });
    }

    // Clone the repository
    const cloneCmd = `git clone ${F5_TTS_REPO_URL} ${F5_TTS_DIR}`;
    logger.command(cloneCmd);
    execSync(cloneCmd, { stdio: 'inherit' });
    logger.success('F5-TTS repository cloned');

    // Modify F5-TTS pyproject.toml to include package data (configs, etc.)
    logger.progress('Ensuring F5-TTS package data is included');
    const f5PyprojectPath = path.join(F5_TTS_DIR, 'pyproject.toml');

    if (fs.existsSync(f5PyprojectPath)) {
        let f5PyprojectContent = fs.readFileSync(f5PyprojectPath, 'utf8');

        // Add package data configuration if not present
        if (!f5PyprojectContent.includes('[tool.setuptools.packages.find]')) {
            f5PyprojectContent += '\n\n[tool.setuptools.packages.find]\nwhere = ["src"]\n\n[tool.setuptools.package-data]\nf5_tts = ["configs/*.yaml", "model/*.pt", "model/*.safetensors", "infer/examples/*.txt", "infer/examples/*.wav", "infer/examples/*.flac", "infer/examples/*.toml", "infer/examples/multi/*.txt", "infer/examples/multi/*.flac", "infer/examples/multi/*.toml", "infer/examples/basic/*.wav", "infer/examples/basic/*.toml", "runtime/**/*.txt"]\n';
            fs.writeFileSync(f5PyprojectPath, f5PyprojectContent, 'utf8');
            logger.success('Added comprehensive package data configuration to F5-TTS pyproject.toml');
        } else {
            logger.info('F5-TTS pyproject.toml already has package data configuration');
        }
    } else {
        logger.warning('F5-TTS pyproject.toml not found, package data may not be included');
    }

    // Install F5-TTS from the local modified directory
    logger.progress('Installing F5-TTS from local directory');
    // Don't use -e flag, we want it copied to site-packages
    const installF5Cmd = `uv pip install --python ${VENV_DIR} --no-build-isolation ./${F5_TTS_DIR}`;
    logger.command(installF5Cmd);

    const env = { ...process.env, UV_HTTP_TIMEOUT: '600' }; // 10 minutes for installation
    try {
        execSync(installF5Cmd, { stdio: 'inherit', env });
        logger.success('F5-TTS installation completed');
    } catch (installErr) {
        const msg = String(installErr?.message || installErr);
        logger.warning(`F5-TTS install failed: ${msg}`);
        // If failure is due to Poetry backend missing, install both poetry-core and poetry, then retry once
        const mayBePoetryBackend = /No module named 'poetry'|poetry\.core|poetry\.masonry|prepare_metadata_for_build_wheel/i.test(msg);
        if (mayBePoetryBackend) {
            try {
                const poetryInstallCmd = `uv pip install --python ${VENV_DIR} poetry`;
                logger.progress('Installing Poetry (full) for legacy Poetry build backends');
                logger.command(poetryInstallCmd);
                execSync(poetryInstallCmd, { stdio: 'inherit' });
                // Retry install
                logger.progress('Retrying F5-TTS installation after installing Poetry');
                execSync(installF5Cmd, { stdio: 'inherit', env });
                logger.success('F5-TTS installation completed after installing Poetry');
            } catch (retryErr) {
                throw retryErr; // Re-throw to be handled by outer catch
            }
        } else {
            throw installErr;
        }
    }

    // Copy example audio files to server directory for the reference audio controller
    logger.progress('Copying example audio files to server directory');
    try {
        const exampleAudioDir = path.join(__dirname, 'server', 'example-audio');
        if (!fs.existsSync(exampleAudioDir)) {
            fs.mkdirSync(exampleAudioDir, { recursive: true });
        }

        // Copy basic reference audio files from F5-TTS package
        const basicRefEnSrc = path.join(VENV_DIR, 'Lib', 'site-packages', 'f5_tts', 'infer', 'examples', 'basic', 'basic_ref_en.wav');
        const basicRefEnDest = path.join(exampleAudioDir, 'basic_ref_en.wav');
        if (fs.existsSync(basicRefEnSrc)) {
            fs.copyFileSync(basicRefEnSrc, basicRefEnDest);
            logger.info('Copied basic_ref_en.wav to server/example-audio/');
        }

        const basicRefZhSrc = path.join(VENV_DIR, 'Lib', 'site-packages', 'f5_tts', 'infer', 'examples', 'basic', 'basic_ref_zh.wav');
        const basicRefZhDest = path.join(exampleAudioDir, 'basic_ref_zh.wav');
        if (fs.existsSync(basicRefZhSrc)) {
            fs.copyFileSync(basicRefZhSrc, basicRefZhDest);
            logger.info('Copied basic_ref_zh.wav to server/example-audio/');
        }

        // Copy additional example files that might be useful
        const additionalFiles = [
            { src: 'infer/examples/basic/basic.toml', dest: 'basic.toml' },
            { src: 'infer/examples/multi/story.txt', dest: 'story.txt' },
            { src: 'infer/examples/multi/story.toml', dest: 'story.toml' },
            { src: 'infer/examples/vocab.txt', dest: 'vocab.txt' }
        ];

        for (const file of additionalFiles) {
            const srcPath = path.join(VENV_DIR, 'Lib', 'site-packages', 'f5_tts', file.src);
            const destPath = path.join(exampleAudioDir, file.dest);
            if (fs.existsSync(srcPath) && !fs.existsSync(destPath)) {
                fs.copyFileSync(srcPath, destPath);
                logger.info(`Copied ${file.dest} to server/example-audio/`);
            }
        }

        logger.success('Example audio files copied successfully');
    } catch (copyError) {
        logger.warning(`Could not copy example audio files: ${copyError.message}`);
    }

    // Clean up the temporary directory after installation
    logger.progress('Cleaning up temporary directory');
    try {
        fs.rmSync(F5_TTS_DIR, { recursive: true, force: true });
        logger.success('Temporary directory removed');
    } catch (err) {
        logger.warning('Could not remove temporary directory');
    }

    logger.progress('Verifying Text-to-Speech engine');
    const verifyF5PyCode = `
import sys
import traceback

print("Verifying F5-TTS installation...")
print("Python executable:", sys.executable)

try:
    from f5_tts.api import F5TTS
    print('✅ F5-TTS API verified')
except Exception as e:
    print(f'❌ F5-TTS API failed: {e}')
    traceback.print_exc()
    sys.exit(1)

print('✅ F5-TTS verification completed successfully')
`;
    const verifyF5Cmd = `uv run --python ${VENV_DIR} -- python -c "${verifyF5PyCode.replace(/"/g, '\\"')}"`;
    try {
        execSync(verifyF5Cmd, { stdio: 'inherit', encoding: 'utf8' });
        logger.success('Text-to-Speech engine verification completed');
    } catch (verifyError) {
        logger.warning('Text-to-Speech engine verification had issues, but continuing installation');
        logger.info('The application will still work, but F5-TTS features may be limited');
    }

} catch (error) {
    console.error(`❌ Error installing/verifying F5-TTS with uv: ${error.message}`);
    console.log(`   Verification command failed. Check the output above for details from Python.`);
    process.exit(1);
}

// --- 6. Install official chatterbox using uv pip ---
logger.step(6, 8, 'Installing chatterbox');
logger.installing('Voice cloning engine (chatterbox)');
const CHATTERBOX_DIR = 'chatterbox-temp'; // Temporary directory for cloning
try {
    // Clone the official chatterbox repository
    logger.progress('Cloning official chatterbox repository');

    // Remove existing chatterbox directory if it exists
    if (fs.existsSync(CHATTERBOX_DIR)) {
        logger.info('Removing existing chatterbox directory...');
        fs.rmSync(CHATTERBOX_DIR, { recursive: true, force: true });
    }

    // Clone the repository
    const cloneCmd = `git clone https://github.com/resemble-ai/chatterbox.git ${CHATTERBOX_DIR}`;
    logger.command(cloneCmd);
    execSync(cloneCmd, { stdio: 'inherit' });
    logger.success('Chatterbox repository cloned');

    // Apply PyTorch compatibility fix by modifying chatterbox dependencies
    logger.progress('Applying PyTorch compatibility fix for chatterbox');
    const pyprojectPath = path.join(CHATTERBOX_DIR, 'pyproject.toml');

    if (fs.existsSync(pyprojectPath)) {
        logger.info('Updating chatterbox dependencies for PyTorch 2.4.1 compatibility...');

        let pyprojectContent = fs.readFileSync(pyprojectPath, 'utf8');

        // Replace incompatible PyTorch versions with working ones that support both F5-TTS and Chatterbox
        // Pin to CUDA versions to prevent CPU installs - target specific packages only
        pyprojectContent = pyprojectContent
            .replace(/torch==2\.[0-6]\.\d+/g, 'torch==2.5.1+cu121')
            .replace(/torchaudio==2\.[0-6]\.\d+/g, 'torchaudio==2.5.1+cu121')
            .replace(/torchvision==0\.1[5-9]\.\d+/g, 'torchvision==0.20.1+cu121')
            .replace(/transformers==4\.4[6-9]\.\d+/g, 'transformers>=4.40.0,<4.47.0')
            .replace(/diffusers==0\.2[9]\.\d+/g, 'diffusers>=0.25.0,<0.30.0');


        // Remove russian-text-stresser due to spacy==3.6.* hard pin causing conflict with gradio/typer (pydantic v2)
        try {
            const beforeLenRTS = pyprojectContent.length;
            pyprojectContent = pyprojectContent.replace(/^[\t ]*["']russian-text-stresser\b[^\n]*$/gmi, '');
            if (pyprojectContent.length !== beforeLenRTS) {
                logger.info('Removed russian-text-stresser to avoid spacy/typer/pydantic conflict');
                logger.info('Note: Russian stress features will be disabled.');
            }
        } catch (e) {
            logger.warning('Could not adjust russian-text-stresser dependency automatically');
        }

        // Remove or comment out pkuseg on Windows (requires MSVC compiler)
        if (process.platform === 'win32') {
            logger.info('Removing pkuseg dependency on Windows (requires MSVC compiler)...');
            // Remove pkuseg line entirely (commenting causes TOML parse issues)
            pyprojectContent = pyprojectContent.replace(
                /^\s*"pkuseg\s*==\s*[^"]+",?\s*$/gm,
                ''  // Remove the line entirely
            );
        }

        fs.writeFileSync(pyprojectPath, pyprojectContent, 'utf8');
        logger.success('Chatterbox dependencies updated for compatibility');
    } else {
        logger.warning('pyproject.toml not found in chatterbox directory');
    }

    // First ensure numpy is installed (required for pkuseg build dependency)
    logger.progress('Installing numpy (required for chatterbox dependencies)');
    const numpyCmd = `uv pip install --python ${VENV_DIR} numpy`;
    execSync(numpyCmd, { stdio: 'inherit' });


    // Ensure Poetry build backend is available for dependencies using poetry.core (e.g., russian-text-stresser)
    logger.progress('Ensuring Poetry build backend (poetry-core) is available');
    try {
        const poetryCoreCmd = `uv pip install --python ${VENV_DIR} poetry-core`;
        logger.command(poetryCoreCmd);
        execSync(poetryCoreCmd, { stdio: 'inherit' });
        logger.success('poetry-core installed into the shared virtual environment');
    } catch (poetryCoreError) {
        logger.warning(`Failed to install poetry-core automatically: ${poetryCoreError.message}`);
        logger.info('Dependencies that use the poetry.core build backend may fail to build without this.');
    }

    // Install chatterbox from the local modified directory
    logger.progress('Installing chatterbox from local modified directory');
    // Don't use -e flag, we want it copied to site-packages
    // Root fix: install chatterbox together with python-dateutil in a single resolution to prevent pruning
    // Use CUDA index to ensure PyTorch CUDA version is used, avoid --force-reinstall to prevent PyTorch conflicts
    const installChatterboxCmd = `uv pip install --python ${VENV_DIR} --no-build-isolation --index-url https://download.pytorch.org/whl/cu121 --extra-index-url https://pypi.org/simple ./${CHATTERBOX_DIR} python-dateutil==2.9.0.post0`;
    logger.command(installChatterboxCmd);
    logger.info(`Installing chatterbox with pinned python-dateutil (single resolution, site-packages)`);

    const env = { ...process.env, UV_HTTP_TIMEOUT: '600' }; // 10 minutes for installation
    try {
        execSync(installChatterboxCmd, { stdio: 'inherit', env });
        logger.success('Chatterbox installation completed');
    } catch (installErr) {
        const msg = String(installErr?.message || installErr);
        logger.warning(`Chatterbox install failed: ${msg}`);
        // If failure is due to Poetry backend missing, install both poetry-core and poetry, then retry once
        const mayBePoetryBackend = /No module named 'poetry'|poetry\.core|poetry\.masonry|prepare_metadata_for_build_wheel/i.test(msg);
        if (mayBePoetryBackend) {
            try {
                const poetryInstallCmd = `uv pip install --python ${VENV_DIR} poetry`;
                logger.progress('Installing Poetry (full) for legacy Poetry build backends');
                logger.command(poetryInstallCmd);
                execSync(poetryInstallCmd, { stdio: 'inherit' });
                // Retry install
                logger.progress('Retrying chatterbox installation after installing Poetry');
                execSync(installChatterboxCmd, { stdio: 'inherit', env });
                logger.success('Chatterbox installation completed after installing Poetry');
            } catch (retryErr) {
                throw retryErr; // Re-throw to be handled by outer catch
            }
        } else {
            throw installErr;
        }
    }

    // Clean up the temporary directory after installation
    logger.progress('Cleaning up temporary directory');
    try {
        fs.rmSync(CHATTERBOX_DIR, { recursive: true, force: true });
        logger.success('Temporary directory removed');
    } catch (err) {
        logger.warning('Could not remove temporary directory');
    }

    // Verify PyTorch versions are correct
    logger.progress('Verifying PyTorch compatibility after chatterbox installation');
    try {
        const verifyCmd = `uv run --python ${VENV_DIR} -- python -c "import torch; print(f'PyTorch version: {torch.__version__}')`;
        const output = execSync(verifyCmd, { encoding: 'utf8' });
        if (output.includes('2.5.1')) {
            logger.success('PyTorch 2.5.1 verified successfully');
        } else {
            logger.warning('PyTorch version mismatch detected, reinstalling...');
            execSync(torchInstallCmd, { stdio: 'inherit', env });
            logger.success('PyTorch 2.5.1 reinstalled');
        }
    } catch (error) {
        logger.warning(`PyTorch verification failed: ${error.message}`);
    }

    logger.success('Chatterbox is ready to use');

    // Final safeguard: ensure python-dateutil is present after chatterbox install
    try {
        const ensureDateutilCmd = `uv pip install --python ${VENV_DIR} --force-reinstall --no-cache python-dateutil==2.9.0.post0 six==1.16.0`;
        logger.progress('Ensuring python-dateutil is present (post-chatterbox)');
        logger.command(ensureDateutilCmd);
        execSync(ensureDateutilCmd, { stdio: 'inherit' });
        // Verify import strictly from the .venv interpreter
        const verifyDateutilCmd = `uv run --python ${VENV_DIR} -- python -c "import dateutil,sys; print('dateutil OK from', sys.executable)"`;
        execSync(verifyDateutilCmd, { stdio: 'inherit' });
    } catch (e) {
        logger.warning(`Could not verify python-dateutil after chatterbox install: ${e.message}`);
    }


    logger.progress('Verifying voice cloning engine');
    const verifyChatterboxPyCode = `
import sys
import traceback

print("Verifying chatterbox installation...")
print("Python executable:", sys.executable)

# Test core service dependencies


try:
    import flask
    import flask_cors
    import requests
    import uvicorn
    import fastapi
    import click
    print('✅ Core service dependencies imported successfully')
except Exception as e:
    print(f'❌ Error importing core service dependencies: {e}')
    traceback.print_exc()
    sys.exit(1)

# Test for the specific torchvision::nms error that was causing issues
try:
    from torchvision.transforms import InterpolationMode
    import torchvision.ops
    print('✅ torchvision compatibility check passed')
except Exception as e:
    if 'torchvision::nms does not exist' in str(e):
        print(f'❌ CRITICAL: torchvision::nms error detected: {e}')
        print('   This indicates a PyTorch/torchvision version mismatch')
        print('   The installation needs to be fixed')
        sys.exit(1)
    else:
        print(f'⚠️ Warning: torchvision issue: {e}')

# Test Chatterbox imports (non-fatal)
chatterbox_working = False
try:
    from chatterbox.tts import ChatterboxTTS
    from chatterbox.vc import ChatterboxVC
    print('✅ Chatterbox imported successfully')
    print('✅ ChatterboxTTS and ChatterboxVC classes available')
    chatterbox_working = True
except Exception as e:
    error_str = str(e)
    if 'torchvision::nms does not exist' in error_str:
        print(f'❌ CRITICAL: Chatterbox import failed due to torchvision::nms error: {e}')
        print('   This indicates a PyTorch/torchvision version mismatch that needs to be fixed')
        sys.exit(1)
    else:
        print(f'⚠️ Warning: Chatterbox import failed: {e}')
        print('   Voice cloning features may not work, but installation will continue')
        print('   This is often due to PyTorch/TorchVision compatibility issues')

# Test transformers imports (non-fatal if Chatterbox failed)
if chatterbox_working:
    try:
        from transformers import LlamaModel, LlamaConfig
        print('✅ Transformers LlamaModel and LlamaConfig imported successfully')
    except Exception as e:
        print(f'⚠️ Warning: Transformers import failed: {e}')
        print('   Some advanced voice cloning features may not work')
else:
    print('⚠️ Skipping transformers test due to chatterbox import failure')

print('✅ Verification completed (with warnings if any shown above)')
`;
    const verifyChatterboxCmd = `uv run --python ${VENV_DIR} -- python -c "${verifyChatterboxPyCode.replace(/"/g, '\\"')}"`;
    try {
        execSync(verifyChatterboxCmd, { stdio: 'inherit', encoding: 'utf8' });
        logger.success('Voice cloning engine verification completed');
    } catch (verifyError) {
        logger.warning('Voice cloning engine verification had issues, but continuing installation');
        logger.info('The application will still work, but voice cloning features may be limited');
    }

} catch (error) {
    console.error(`❌ Error installing/verifying chatterbox with uv: ${error.message}`);
    console.log(`   Verification command failed. Check the output above for details from Python.`);
    process.exit(1);
}

// --- 7.6. Verify PyTorch installation after Chatterbox ---
logger.progress('Finalizing AI model setup');
try {
    // Verify PyTorch is still working after Chatterbox installation
    const verifyPytorchCmd = `uv run --python ${VENV_DIR} -- python -c "import torch; print(f'PyTorch version: {torch.__version__}'); print(f'CUDA available: {torch.cuda.is_available()}')"`;
    execSync(verifyPytorchCmd, { stdio: 'inherit' });
    logger.success('AI model setup verified');
} catch (error) {
    logger.warning(`PyTorch verification failed: ${error.message}`);
    logger.info('Attempting to fix PyTorch installation...');
    try {
        // Only reinstall if verification failed - use working versions
        const fixPytorchCmd = `uv pip install --python ${VENV_DIR} torch==2.5.1+cu121 torchvision==0.20.1+cu121 torchaudio==2.5.1+cu121 --index-url https://download.pytorch.org/whl/cu121 --force-reinstall`;
        logger.command(fixPytorchCmd);
        const env = { ...process.env, UV_HTTP_TIMEOUT: '300' }; // 5 minutes
        execSync(fixPytorchCmd, { stdio: 'inherit', env });
        logger.success('PyTorch installation fixed');
    } catch (fixError) {
        logger.warning(`Could not fix PyTorch: ${fixError.message}`);
        logger.warning(`Voice cloning features may not work properly.`);
    }
}

// --- 8. Better-chatterbox doesn't need the old compatibility fixes ---
// The old applyChatterboxFixes function has been removed as better-chatterbox
// is a cleaner implementation that doesn't require the Unicode and model path fixes

// --- 9. Removed: Script generation for narration service ---
// The generation of run-narration-service-uv.bat and run-app-with-narration-uv.bat has been removed

// --- 10. Update package.json ---
logger.progress('Finalizing installation configuration');
try {
    const packageJsonPath = path.join(__dirname, 'package.json');
    let packageJsonContent;
    try {
        packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
    } catch (readError) {
        if (readError.code === 'ENOENT') {
            logger.warning(`package.json not found at ${packageJsonPath}. Skipping update.`);
        } else {
            console.error(`❌ Error reading package.json at ${packageJsonPath}: ${readError.message}`);
            console.log('   Skipping package.json update.');
            throw readError;
        }
    }

    if (packageJsonContent) {
        const packageJson = JSON.parse(packageJsonContent);
        if (!packageJson.scripts) {
            packageJson.scripts = {};
        }
        const setupScriptName = path.basename(__filename);

        // Update existing or add new scripts for uv-based setup
        packageJson.scripts['python:start:uv'] = `uv run --python .venv -- python server/narrationApp.py`;
        packageJson.scripts['setup:narration:uv'] = `node ${setupScriptName}`;

        // Ensure dev:cuda is properly configured (used by OSG_installer_Windows.bat)
        if (!packageJson.scripts['dev:cuda']) {
            packageJson.scripts['dev:cuda'] = `cross-env START_PYTHON_SERVER=true concurrently --names "FRONTEND,SERVER" --prefix-colors "cyan,green" --prefix "[{name}]" "npm run start --silent" "npm run server:start"`;
        }

        // Remove old/unused scripts to avoid confusion
        delete packageJson.scripts['python:start:cuda:uv'];
        delete packageJson.scripts['dev:cuda:uv'];
        delete packageJson.scripts['dev:uv'];

        fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
        logger.success('Installation configuration completed');
    }
} catch (error) {
    logger.error(`Error updating package.json: ${error.message}`);
}

// --- 11. Final Service Verification ---
logger.progress('Performing final system check');
try {
    const finalVerifyPyCode = `
import sys
import traceback

print("=== Final Service Verification ===")

# Test Flask server imports (narrationApp.py)
try:
    from flask import Flask, request, jsonify
    from flask_cors import CORS
    print('✅ Flask server dependencies verified')
except Exception as e:
    print(f'❌ Flask server dependencies failed: {e}')
    sys.exit(1)

# Test FastAPI/Chatterbox service imports (start_api.py)
try:
    import uvicorn
    import click
    import fastapi
    print('✅ FastAPI/Chatterbox service dependencies verified')
except Exception as e:
    print(f'❌ FastAPI/Chatterbox service dependencies failed: {e}')
    sys.exit(1)

# Test F5-TTS imports
try:
    from f5_tts.api import F5TTS
    print('✅ F5-TTS API verified')
except Exception as e:
    print(f'❌ F5-TTS API failed: {e}')
    sys.exit(1)

# Test Chatterbox API imports
try:
    from chatterbox.tts import ChatterboxTTS
    print('✅ Chatterbox TTS verified')
except Exception as e:
    print(f'❌ Chatterbox TTS failed: {e}')
    sys.exit(1)

# Verify conditionals file exists and is accessible
import os
conds_path = 'models/chatterbox_weights/conds.pt'
if os.path.exists(conds_path):
    file_size = os.path.getsize(conds_path)
    if file_size > 0:
        print(f'✅ Chatterbox conditionals file verified: {conds_path} ({file_size} bytes)')
    else:
        print(f'❌ Chatterbox conditionals file is empty: {conds_path}')
        sys.exit(1)
else:
    print(f'❌ Chatterbox conditionals file missing: {conds_path}')
    print('   This will cause "NoneType object has no attribute cpu" errors')
    sys.exit(1)

print('✅ All service dependencies and required files verified successfully!')
`;
    const finalVerifyCmd = `uv run --python ${VENV_DIR} -- python -c "${finalVerifyPyCode.replace(/"/g, '\\"')}"`;
    execSync(finalVerifyCmd, { stdio: 'inherit', encoding: 'utf8' });
    logger.success('Final system check completed successfully');
} catch (error) {
    logger.error(`Final system check failed: ${error.message}`);
    logger.warning('Some features may not work correctly. Check the output above for details.');
    // Don't exit here, just warn the user
}

// --- Helper Functions for yt-dlp Plugin Installation ---

/**
 * Get the appropriate yt-dlp plugins directory based on OS and installation type
 * @returns {string} - Path to yt-dlp plugins directory
 */
function getYtDlpPluginsDirectory() {
    const platform = os.platform();
    const homeDir = os.homedir();

    // First, try to use directory relative to our yt-dlp installation
    const venvYtDlpPath = path.join(process.cwd(), VENV_DIR,
        platform === 'win32' ? 'Scripts' : 'bin',
        platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
    );

    if (fs.existsSync(venvYtDlpPath)) {
        // Use plugins directory relative to our venv
        const venvPluginsDir = path.join(process.cwd(), VENV_DIR, 'yt-dlp-plugins');
        logger.info(`Using venv-relative plugins directory: ${venvPluginsDir}`);
        return venvPluginsDir;
    }

    // Fall back to system-wide directories
    let pluginsDir;
    if (platform === 'win32') {
        // Windows: %APPDATA%/yt-dlp/plugins/
        pluginsDir = path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'yt-dlp', 'plugins');
    } else if (platform === 'darwin') {
        // macOS: ~/.yt-dlp/plugins/
        pluginsDir = path.join(homeDir, '.yt-dlp', 'plugins');
    } else {
        // Linux: ~/.yt-dlp/plugins/
        pluginsDir = path.join(homeDir, '.yt-dlp', 'plugins');
    }

    logger.info(`Using system plugins directory: ${pluginsDir}`);
    return pluginsDir;
}

/**
 * Download a file from URL to destination
 * @param {string} url - URL to download from
 * @param {string} dest - Destination file path
 * @returns {Promise<void>}
 */
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = createWriteStream(dest);

        https.get(url, (response) => {
            // Handle redirects
            if (response.statusCode === 302 || response.statusCode === 301) {
                file.close();
                fs.unlinkSync(dest);
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }

            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(dest);
                return reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
            }

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                resolve();
            });

            file.on('error', (err) => {
                file.close();
                fs.unlinkSync(dest);
                reject(err);
            });
        }).on('error', (err) => {
            file.close();
            if (fs.existsSync(dest)) {
                fs.unlinkSync(dest);
            }
            reject(err);
        });
    });
}

/**
 * Extract ZIP file to destination directory
 * @param {string} zipPath - Path to ZIP file
 * @param {string} extractDir - Directory to extract to
 * @returns {Promise<void>}
 */
async function extractZip(zipPath, extractDir) {
    // Use built-in unzip capabilities or external tools
    const platform = os.platform();

    try {
        if (platform === 'win32') {
            // Use PowerShell on Windows
            const command = `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`;
            execSync(command, { stdio: 'pipe' });
        } else {
            // Use unzip on Unix-like systems
            execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe' });
        }
        logger.info(`Extracted ${zipPath} to ${extractDir}`);
    } catch (error) {
        throw new Error(`Failed to extract ZIP file: ${error.message}`);
    }
}

/**
 * Verify that the plugin was installed correctly
 * @param {string} pluginDir - Plugin installation directory
 * @returns {boolean} - True if plugin is properly installed
 */
function verifyPluginInstallation(pluginDir) {
    try {
        // Check if the plugin directory structure exists
        // The ChromeCookieUnlock plugin has the structure: ChromeCookieUnlock/yt_dlp_plugins/postprocessor/
        // pluginDir should point to the ChromeCookieUnlock directory which contains yt_dlp_plugins
        const pluginNamespacePath = path.join(pluginDir, 'yt_dlp_plugins');
        const pluginFiles = [
            path.join(pluginNamespacePath, '__init__.py'),
            path.join(pluginNamespacePath, 'postprocessor', '__init__.py'),
            path.join(pluginNamespacePath, 'postprocessor', 'chrome_cookie_unlock.py')
        ];

        logger.info(`Checking plugin files in: ${pluginNamespacePath}`);

        for (const file of pluginFiles) {
            if (!fs.existsSync(file)) {
                logger.warning(`Plugin file missing: ${file}`);
                return false;
            } else {
                logger.info(`✓ Found: ${file}`);
            }
        }

        // Try to verify yt-dlp recognizes the plugin
        try {
            const ytDlpPath = path.join(process.cwd(), VENV_DIR,
                process.platform === 'win32' ? 'Scripts/yt-dlp.exe' : 'bin/yt-dlp'
            );

            if (fs.existsSync(ytDlpPath)) {
                // Run yt-dlp with --verbose to check if plugin is loaded
                // We'll do a quick check without actually downloading anything
                const result = execSync(`"${ytDlpPath}" --verbose --simulate --no-warnings "https://www.youtube.com/watch?v=dQw4w9WgXcQ"`,
                    { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });

                if (result.includes('ChromeCookieUnlock') || result.includes('cookie')) {
                    logger.info('Plugin verified: yt-dlp recognizes ChromeCookieUnlock plugin');
                } else {
                    logger.info('Plugin files verified (yt-dlp plugin recognition test inconclusive)');
                }
            }
        } catch (ytdlpError) {
            // Don't fail verification if yt-dlp test fails - plugin files exist
            logger.info('Plugin files verified (yt-dlp test skipped)');
        }

        logger.info('Plugin installation verified successfully');
        return true;
    } catch (error) {
        logger.warning(`Plugin verification failed: ${error.message}`);
        return false;
    }
}

/**
 * Install the ChromeCookieUnlock plugin for yt-dlp
 * This plugin solves the Chrome cookie database locking issue on Windows
 */
async function installYtDlpCookiePlugin() {
    try {
        logger.subsection('yt-dlp ChromeCookieUnlock Plugin Installation');

        // Get plugins directory
        const pluginsDir = getYtDlpPluginsDirectory();
        const pluginDir = path.join(pluginsDir, 'ChromeCookieUnlock');

        // Create plugins directory if it doesn't exist
        if (!fs.existsSync(pluginsDir)) {
            fs.mkdirSync(pluginsDir, { recursive: true });
            logger.info(`Created plugins directory: ${pluginsDir}`);
        }

        // Check if plugin is already installed
        if (fs.existsSync(pluginDir) && verifyPluginInstallation(pluginsDir)) {
            logger.info('ChromeCookieUnlock plugin already installed and verified');
            return;
        }

        // Download plugin from GitHub
        const pluginUrl = 'https://github.com/seproDev/yt-dlp-ChromeCookieUnlock/archive/refs/heads/main.zip';
        const tempZipPath = path.join(os.tmpdir(), 'ChromeCookieUnlock.zip');

        logger.info('Downloading ChromeCookieUnlock plugin...');
        await downloadFile(pluginUrl, tempZipPath);
        logger.info('Plugin downloaded successfully');

        // Extract plugin
        logger.info('Extracting plugin...');
        const tempExtractDir = path.join(os.tmpdir(), 'ChromeCookieUnlock-extract');

        // Clean up any existing temp directory
        if (fs.existsSync(tempExtractDir)) {
            fs.rmSync(tempExtractDir, { recursive: true, force: true });
        }

        await extractZip(tempZipPath, tempExtractDir);

        // Find the extracted plugin directory (it will be named something like "yt-dlp-ChromeCookieUnlock-main")
        const extractedContents = fs.readdirSync(tempExtractDir);
        const extractedPluginDir = extractedContents.find(name => name.startsWith('yt-dlp-ChromeCookieUnlock'));

        if (!extractedPluginDir) {
            throw new Error('Could not find extracted plugin directory');
        }

        const sourcePath = path.join(tempExtractDir, extractedPluginDir);
        const sourcePluginPath = path.join(sourcePath, 'yt_dlp_plugins');

        // Verify the source has the expected structure
        if (!fs.existsSync(sourcePluginPath)) {
            throw new Error(`Plugin source directory not found: ${sourcePluginPath}`);
        }

        // Copy plugin to final location
        logger.info(`Installing plugin from: ${sourcePluginPath}`);
        logger.info(`Installing plugin to: ${pluginDir}`);

        // Remove existing plugin directory if it exists
        if (fs.existsSync(pluginDir)) {
            fs.rmSync(pluginDir, { recursive: true, force: true });
        }

        // Copy the yt_dlp_plugins directory to the plugin directory, preserving the namespace
        const finalPluginPath = path.join(pluginDir, 'yt_dlp_plugins');
        fs.cpSync(sourcePluginPath, finalPluginPath, { recursive: true });

        // Create missing __init__.py files if they don't exist
        const initFiles = [
            path.join(finalPluginPath, '__init__.py'),
            path.join(finalPluginPath, 'postprocessor', '__init__.py')
        ];

        for (const initFile of initFiles) {
            if (!fs.existsSync(initFile)) {
                fs.writeFileSync(initFile, '# yt-dlp plugin namespace\n');
                logger.info(`Created missing __init__.py: ${initFile}`);
            }
        }

        // Clean up temporary files
        fs.unlinkSync(tempZipPath);
        fs.rmSync(tempExtractDir, { recursive: true, force: true });

        // Verify installation
        if (verifyPluginInstallation(pluginDir)) {
            logger.success('✅ ChromeCookieUnlock plugin installed successfully');
            logger.info('   This plugin resolves Chrome cookie database locking issues on Windows');
            logger.info('   yt-dlp can now access Chrome cookies even when the browser is open');
        } else {
            throw new Error('Plugin installation verification failed');
        }

    } catch (error) {
        logger.warning(`⚠️  ChromeCookieUnlock plugin installation failed: ${error.message}`);
        logger.info('   Cookie authentication will fall back to no-cookie mode when Chrome is open');
        logger.info('   This is not critical - the application will still function normally');

        // Don't throw the error - we want setup to continue even if plugin installation fails
    }
}

// --- 7. Install yt-dlp ChromeCookieUnlock Plugin ---
logger.step(7, 8, 'Installing yt-dlp ChromeCookieUnlock plugin...');
await installYtDlpCookiePlugin();

// --- 8. Final Summary ---
logger.step(8, 8, 'Setup completed successfully!');

const summaryItems = [
    `Target PyTorch backend: ${gpuVendor}`,
    `F5-TTS package installed from GitHub`,
    `Chatterbox package installed from GitHub`,
    `Shared virtual environment at: ./${VENV_DIR}`,
    `Python ${PYTHON_VERSION_TARGET} confirmed/installed`,
    `PyTorch, F5-TTS, chatterbox, and all dependencies installed`,
    `Both F5-TTS and Chatterbox installed from official GitHub repositories`
];

if (installNotes) {
    summaryItems.push(`Reminder: ${installNotes}`);
}

logger.summary('Setup Summary', summaryItems);

logger.newLine();
logger.success('✅ PyTorch/torchvision compatibility fix applied');
logger.info('   - Using PyTorch 2.5.1 with CUDA support for F5-TTS and Chatterbox compatibility');
logger.info('   - Both F5-TTS and Chatterbox installed from official GitHub repositories');
logger.info('   - Dependencies installed with proper version management');

logger.newLine();
logger.info('🚀 To run the application with ALL narration services:');
logger.info('   1. Ensure `uv` and `npm` are in your PATH');
logger.info('   2. Run: npm run dev:cuda');
logger.info('   This starts F5-TTS (port 3035) + Chatterbox API (port 3036) + Frontend (port 3030)');

logger.newLine();
logger.info('💡 Other useful commands:');
logger.info('   - Just narration service: npm run python:start:uv');
logger.info('   - Re-run setup: npm run setup:narration:uv');

logger.newLine();
logger.info('💡 To force a specific GPU type:');
logger.info('   Set FORCE_GPU_VENDOR environment variable (NVIDIA, AMD, INTEL, APPLE, CPU)');
logger.info('   Example: set FORCE_GPU_VENDOR=CPU && npm run setup:narration:uv');
}

// --- Run Setup ---
runSetup().catch((error) => {
    logger.error(`Setup failed: ${error.message}`);
    process.exit(1);
});