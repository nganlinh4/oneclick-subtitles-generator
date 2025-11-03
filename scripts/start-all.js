/**
 * Comprehensive startup script for all services
 * Handles port cleanup and process tracking
 */

const { spawn } = require('child_process');
const path = require('path');

// Import port management and CORS setup
const { killProcessesOnPorts, cleanupTrackingFile } = require('../server/utils/portManager');
const { setupEnvironmentVariables } = require('./setup-cors-env');

async function startAllServices() {
  console.log('🚀 Starting One-Click Subtitles Generator...');

  // Setup CORS environment variables
  setupEnvironmentVariables();
  
  try {
    // Clean up old processes and tracking
    console.log('🧹 Cleaning up previous processes...');
    cleanupTrackingFile();
    await killProcessesOnPorts();
    
    console.log('✅ Cleanup complete, starting services...');
    
    // Start all services including the video renderer (same as dev but with CUDA support)
    console.log('🚀 Starting all services: FRONTEND, SERVER, RENDERER, MIDI, PARAKEET with CUDA support...');

    // Use the same cross-platform approach as dev-server.js
    const { spawn } = require('child_process');

    // Commands to run - cross-platform approach (same as dev-server.js)
    const commands = [
      { name: 'FRONTEND', cmd: 'npm', args: ['run', 'start'], cwd: '.' },
      { name: 'SERVER', cmd: 'npm', args: ['run', 'server:start'], cwd: '.' },
      { name: 'RENDERER', cmd: 'npm', args: ['run', 'video-renderer:start'], cwd: '.' },
      { name: 'MIDI', cmd: 'npm', args: ['run', 'dev', '--silent'], cwd: './promptdj-midi' },
      // Run Parakeet from project root so --python .venv resolves; pass absolute .venv for safety
      { name: 'PARAKEET', cmd: 'uv', args: ['run', '--python', path.join(process.cwd(), '.venv'), 'python', path.join('parakeet_wrapper', 'app.py')], cwd: '.' }
    ];

    // Colors for different services (same as dev-server.js)
    const colors = {
      FRONTEND: '\x1b[36m', // cyan
      SERVER: '\x1b[32m',   // green
      RENDERER: '\x1b[35m', // magenta
      MIDI: '\x1b[34m',     // blue
      PARAKEET: '\x1b[33m'   // yellow
    };

    // Function to prefix output with colored service name
    function prefixOutput(serviceName, data) {
      const color = colors[serviceName];
      const reset = '\x1b[0m';
      const lines = data.toString().split('\n');
      return lines
        .filter(line => line.trim() !== '')
        .map(line => `${color}[${serviceName}]${reset} ${line}`)
        .join('\n');
    }

    // Start all services with proper sequencing (same approach as dev-server.js)
    commands.forEach(({ name, cmd, args, cwd }) => {
      const childProcess = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true, // Use shell: true for cross-platform npm compatibility
        cwd: cwd,
        env: {
          ...process.env,
          START_PYTHON_SERVER: 'true',
          DEV_SERVER_MANAGED: 'true'
        }
      });

      childProcess.stdout.on('data', (data) => {
        console.log(prefixOutput(name, data));
      });

      childProcess.stderr.on('data', (data) => {
        console.log(prefixOutput(name, data));
      });

      childProcess.on('close', (code) => {
        const color = colors[name];
        const reset = '\x1b[0m';
        console.log(`${color}[${name}]${reset} Process exited with code ${code}`);
      });

      childProcess.on('error', (err) => {
        const color = colors[name];
        const reset = '\x1b[0m';
        console.log(`${color}[${name}]${reset} Error: ${err.message}`);
      });
    });

    // Handle shutdown gracefully
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down all services...');
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\n🛑 Shutting down all services...');
      process.exit(0);
    });

  } catch (error) {
    console.error('❌ Error during startup:', error);
    process.exit(1);
  }
}

// Start all services
startAllServices();
