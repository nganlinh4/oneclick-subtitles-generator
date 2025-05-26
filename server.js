/**
 * Local server for downloading YouTube videos
 * This server handles downloading YouTube videos to a local 'videos' directory
 * Also handles caching of subtitles to avoid repeated Gemini API calls
 */

// Import configuration
const { PORT } = require('./server/config');
const { NARRATION_PORT } = require('./server/startNarrationService');

// Import Express app
const app = require('./app');

// Import narration service
const { startNarrationService } = require('./server/startNarrationService');

// Start the narration service only if running with dev:cuda
let narrationProcess;

// Check if we're running with npm run dev:cuda by looking at the environment variable
const isDevCuda = process.env.START_PYTHON_SERVER === 'true';

if (isDevCuda) {

  try {
    narrationProcess = startNarrationService();

    // Set the narration service as running in the app

    app.set('narrationServiceRunning', true);
    app.set('narrationActualPort', NARRATION_PORT);
  } catch (error) {
    console.error('Failed to start narration service:', error);


    // Set the narration service as not running in the app
    app.set('narrationServiceRunning', false);
    app.set('narrationActualPort', null);
  }
} else {



  // Set the narration service as not running in the app
  app.set('narrationServiceRunning', false);
  app.set('narrationActualPort', null);
}

// Start the server
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// WebSocket server setup
const { WebSocketServer, WebSocket } = require('ws'); // Import WebSocket
const wss = new WebSocketServer({ server });
const videoSocketMap = {}; // Initialize videoSocketMap

// Make wss and videoSocketMap accessible to routes
app.set('wss', wss);
app.set('videoSocketMap', videoSocketMap);

console.log('WebSocket server created, listening for connections.');

wss.on('connection', (ws) => {
  console.log('Client connected via WebSocket');
  let registeredVideoId = null; // Scope per client

  ws.on('message', (message) => {
    try {
      const parsedMessage = JSON.parse(message);
      if (parsedMessage.type === 'register' && parsedMessage.videoId) {
        videoSocketMap[parsedMessage.videoId] = ws;
        registeredVideoId = parsedMessage.videoId;
        console.log(`WebSocket client registered for videoId: ${parsedMessage.videoId}`);
        // Optional: Send a confirmation
        ws.send(JSON.stringify({ type: 'registered', videoId: parsedMessage.videoId }));
      }
    } catch (e) {
      console.error('Failed to parse WebSocket message or invalid message format:', e);
      // Send an error message back to the client if the message is not valid JSON
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format.' }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected from WebSocket');
    if (registeredVideoId && videoSocketMap[registeredVideoId] === ws) {
      delete videoSocketMap[registeredVideoId];
      console.log(`WebSocket client for videoId: ${registeredVideoId} unregistered.`);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    if (registeredVideoId && videoSocketMap[registeredVideoId] === ws) {
      delete videoSocketMap[registeredVideoId];
      console.log(`WebSocket client for videoId: ${registeredVideoId} unregistered due to error.`);
    }
  });
});

// Handle server shutdown
process.on('SIGINT', () => {

  server.close(() => {


    // Kill the narration service process
    if (narrationProcess) {

      narrationProcess.kill();
    }

    process.exit(0);
  });
});
