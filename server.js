/**
 * Local server for downloading YouTube videos
 * This server handles downloading YouTube videos to a local 'videos' directory
 * Also handles caching of subtitles to avoid repeated Gemini API calls
 */

// Import configuration
const { PORTS, PORT } = require('./server/config');
const { NARRATION_PORT, CHATTERBOX_PORT } = require('./server/startNarrationService');

// Import Express app
const app = require('./app');

// Import narration service
const { startNarrationService } = require('./server/startNarrationService');

// Import WebSocket progress tracking
const { initializeProgressWebSocket } = require('./server/services/shared/progressWebSocket');

// Import port management
const { killProcessesOnPorts, trackProcess, cleanupTrackingFile } = require('./server/utils/portManager');


// Startup initialization
async function initializeServer() {
  console.log('🚀 Initializing server...');

  // Only do port cleanup if not already done by dev-server.js
  // Check if we're running standalone (not via dev-server.js)
  const isStandalone = !process.env.DEV_SERVER_MANAGED;

  if (isStandalone) {
    // Clean up old tracking file and kill processes on ports
    cleanupTrackingFile();
    await killProcessesOnPorts();
  } else {
    console.log('ℹ️  Port cleanup handled by dev-server, skipping...');
  }


  console.log('✅ Server initialization complete');
}

// Start the narration services only if running with dev:cuda
let narrationProcesses;

// Check if we're running with npm run dev:cuda by looking at the environment variable
const isDevCuda = process.env.START_PYTHON_SERVER === 'true';

if (isDevCuda) {
  console.log('🚀 Starting narration services (F5-TTS + Chatterbox)...');

  try {
    narrationProcesses = startNarrationService();

    if (narrationProcesses) {
      // Set the narration services as running in the app
      app.set('narrationServiceRunning', true);
      app.set('narrationActualPort', NARRATION_PORT);
      app.set('chatterboxServiceRunning', narrationProcesses.chatterboxProcess !== null);
      app.set('chatterboxActualPort', CHATTERBOX_PORT);

      console.log('✅ Narration services startup completed');
      console.log(`📍 F5-TTS service: http://localhost:${NARRATION_PORT}`);
      console.log(`📍 Chatterbox service: http://localhost:${CHATTERBOX_PORT}`);
    } else {
      throw new Error('Failed to start narration services');
    }
  } catch (error) {
    console.error('❌ Failed to start narration services:', error);

    // Set the narration services as not running in the app
    app.set('narrationServiceRunning', false);
    app.set('narrationActualPort', null);
    app.set('chatterboxServiceRunning', false);
    app.set('chatterboxActualPort', null);
  }
} else {
  console.log('ℹ️  Running without narration services (use npm run dev:cuda for full functionality)');

  // Set the narration services as not running in the app
  app.set('narrationServiceRunning', false);
  app.set('narrationActualPort', null);
  app.set('chatterboxServiceRunning', false);
  app.set('chatterboxActualPort', null);
}

// Start the server with initialization
async function startServer() {
  await initializeServer();

  const server = app.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);

    // Track the main server process
    trackProcess(PORT, process.pid, 'Express Server');

    // Initialize WebSocket server for real-time progress tracking
    initializeProgressWebSocket(server);
  });

  return server;
}

// Start the server
const serverPromise = startServer();

// Handle server shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down server and services...');

  try {
    const server = await serverPromise;

    server.close(() => {
      // Kill the narration service processes
      if (narrationProcesses) {
        if (narrationProcesses.narrationProcess) {
          console.log('🔄 Stopping F5-TTS narration service...');
          narrationProcesses.narrationProcess.kill();
        }

        if (narrationProcesses.chatterboxProcess) {
          console.log('🔄 Stopping Chatterbox service...');
          narrationProcesses.chatterboxProcess.kill();
        }
      }

      console.log('✅ Server shutdown complete');
      process.exit(0);
    });
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});
