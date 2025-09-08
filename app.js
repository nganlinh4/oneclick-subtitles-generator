/**
 * Express application configuration
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Import configuration
const { CORS_ORIGIN, VIDEOS_DIR, SUBTITLES_DIR, NARRATION_DIR, ensureDirectories } = require('./server/config');
const { EXPRESS_CORS_CONFIG, getCorsHeaders } = require('./server/config/corsConfig');

// Import routes
const videoRoutes = require('./server/routes/videoRoutes');
const subtitleRoutes = require('./server/routes/subtitleRoutes');
const cacheRoutes = require('./server/routes/cacheRoutes');
const updateRoutes = require('./server/routes/updateRoutes');
const lyricsRoutes = require('./server/routes/lyricsRoutes');

const settingsRoutes = require('./server/routes/settingsRoutes');
const douyinRoutes = require('./server/routes/douyinRoutes');
const douyinPlaywrightRoutes = require('./server/routes/douyinPlaywrightRoutes');
const allSitesRoutes = require('./server/routes/allSitesRoutes');
const narrationRoutes = require('./server/routes/narrationRoutes');
const testAudioRoute = require('./server/routes/testAudioRoute');
const qualityScanRoutes = require('./server/routes/qualityScanRoutes');
const videoCompatibilityRoutes = require('./server/routes/videoCompatibilityRoutes');
const downloadOnlyRoutes = require('./server/routes/downloadOnlyRoutes');
const downloadManagementRoutes = require('./server/routes/downloadManagementRoutes');
const diagnosticsRoutes = require('./server/routes/diagnostics');
const { scanModels } = require('./server/utils/scan-models');

// Initialize Express app
const app = express();

// Ensure directories exist
ensureDirectories();



// Configure CORS with unified configuration
app.use(cors(EXPRESS_CORS_CONFIG));

// Add CORS headers to all responses for health endpoint
app.use('/api/health', (req, res, next) => {
  const origin = req.headers.origin;
  // If CORS_ORIGIN is an array, check if the request origin is in the allowed list
  if (Array.isArray(CORS_ORIGIN) && origin) {
    if (CORS_ORIGIN.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    } else {
      // Default to the first origin in the list
      res.header('Access-Control-Allow-Origin', CORS_ORIGIN[0]);
    }
  } else {
    // If CORS_ORIGIN is a string, use it directly
    res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
  }
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Pragma, Expires');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

// Configure JSON body parser with increased limit for base64 encoded files
// Note: Keep JSON limit lower than file upload limits to prevent memory issues with JSON payloads
app.use(express.json({ limit: '1gb' }));

// Global download tracking middleware - logs ALL download requests
app.use((req, res, next) => {
  if (req.path.includes('download') && req.method === 'POST') {
    console.log(`[GLOBAL-DOWNLOAD-TRACKER] ${req.method} ${req.path}`, {
      body: req.body,
      timestamp: new Date().toISOString()
    });
  }
  next();
});

// In-memory storage for quality scan results
const qualityScanResults = new Map();

// NUCLEAR OPTION - Start quality scan (returns immediately)
app.all('/api/scan-video-qualities', async (req, res) => {
  console.log(`[NUCLEAR] ${req.method} request to scan-video-qualities from origin:`, req.headers.origin);

  // Set CORS headers first
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Pragma, Expires');
  res.header('Access-Control-Allow-Credentials', 'true');

  console.log(`[NUCLEAR] CORS headers set, processing ${req.method} request`);

  // Add response tracking
  res.on('finish', () => {
    console.log(`[NUCLEAR] Response finished sending to client`);
  });

  res.on('close', () => {
    console.log(`[NUCLEAR] Response connection closed`);
  });

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    console.log('[NUCLEAR] Handling OPTIONS preflight');
    return res.status(200).json({ success: true });
  }

  // Handle POST request - Start scan and return immediately
  if (req.method === 'POST') {
    console.log(`[NUCLEAR] POST request body:`, req.body);
    const { url, useCookies = false } = req.body;

    if (!url) {
      console.log(`[NUCLEAR] Missing URL in request`);
      return res.status(400).json({
        success: false,
        error: 'Video URL is required'
      });
    }

    // Generate a unique scan ID
    const scanId = `scan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store initial status
    qualityScanResults.set(scanId, {
      status: 'scanning',
      url: url,
      startTime: Date.now()
    });

    console.log(`[NUCLEAR] Starting background quality scan for: ${url} (ID: ${scanId})`);

    // Start scan in background (don't await)
    (async () => {
      try {
        const { scanAvailableQualities } = require('./server/services/qualityScanner');
        const qualities = await scanAvailableQualities(url, useCookies);

        console.log(`[NUCLEAR] Background scan completed for ${scanId}, found ${qualities.length} qualities`);

        // Store results
        qualityScanResults.set(scanId, {
          status: 'completed',
          url: url,
          startTime: qualityScanResults.get(scanId).startTime,
          completedTime: Date.now(),
          qualities: qualities,
          success: true,
          message: `Found ${qualities.length} available qualities`
        });
      } catch (error) {
        console.error(`[NUCLEAR] Background scan failed for ${scanId}:`, error);
        qualityScanResults.set(scanId, {
          status: 'error',
          url: url,
          startTime: qualityScanResults.get(scanId).startTime,
          completedTime: Date.now(),
          success: false,
          error: error.message || 'Failed to scan video qualities'
        });
      }
    })();

    // Return immediately with scan ID
    const response = {
      success: true,
      scanId: scanId,
      status: 'scanning',
      message: 'Quality scan started. Use the scanId to check progress.'
    };

    console.log(`[NUCLEAR] Returning immediate response for scan ${scanId}`);
    return res.json(response);
  }

  // Method not allowed
  return res.status(405).json({ error: 'Method not allowed' });
});

// Polling endpoint to check scan status
app.get('/api/scan-video-qualities/:scanId', (req, res) => {
  // Set CORS headers
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Pragma, Expires');
  res.header('Access-Control-Allow-Credentials', 'true');

  const { scanId } = req.params;
  console.log(`[NUCLEAR-POLL] Checking status for scan ${scanId}`);

  const result = qualityScanResults.get(scanId);

  if (!result) {
    return res.status(404).json({
      success: false,
      error: 'Scan ID not found'
    });
  }

  console.log(`[NUCLEAR-POLL] Scan ${scanId} status: ${result.status}`);

  // Return current status
  res.json({
    success: true,
    scanId: scanId,
    status: result.status,
    ...(result.status === 'completed' ? {
      qualities: result.qualities,
      message: result.message
    } : {}),
    ...(result.status === 'error' ? {
      error: result.error
    } : {})
  });

  // Clean up completed/error results after 5 minutes
  if (result.status !== 'scanning' && Date.now() - result.completedTime > 300000) {
    qualityScanResults.delete(scanId);
    console.log(`[NUCLEAR-POLL] Cleaned up scan ${scanId}`);
  }
});

// Serve static directories with CORS headers
const staticOptions = {
  setHeaders: (res, path, stat) => {
    // Get the request origin from the request object
    const req = res.req;
    const origin = req.headers.origin;

    // If CORS_ORIGIN is an array, check if the request origin is in the allowed list
    if (Array.isArray(CORS_ORIGIN) && origin) {
      if (CORS_ORIGIN.includes(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
      } else {
        // Default to the first origin in the list
        res.set('Access-Control-Allow-Origin', CORS_ORIGIN[0]);
      }
    } else {
      // If CORS_ORIGIN is a string, use it directly
      res.set('Access-Control-Allow-Origin', CORS_ORIGIN);
    }

    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Pragma, Expires');
    res.set('Access-Control-Allow-Credentials', 'true');
  }
};

app.use('/videos', express.static(VIDEOS_DIR, staticOptions));
app.use('/videos/album_art', express.static(path.join(VIDEOS_DIR, 'album_art'), staticOptions));
app.use('/subtitles', express.static(SUBTITLES_DIR, staticOptions));
app.use('/narration', express.static(NARRATION_DIR, staticOptions));
app.use('/public', express.static(path.join(__dirname, 'public'), staticOptions));
app.use('/public/videos/album_art', express.static(path.join(__dirname, 'public', 'videos', 'album_art'), staticOptions));

// Add CORS headers to all responses
app.use((req, res, next) => {
  const origin = req.headers.origin;

  // If CORS_ORIGIN is an array, check if the request origin is in the allowed list
  if (Array.isArray(CORS_ORIGIN) && origin) {
    if (CORS_ORIGIN.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    } else {
      // Default to the first origin in the list
      res.header('Access-Control-Allow-Origin', CORS_ORIGIN[0]);
    }
  } else {
    // If CORS_ORIGIN is a string, use it directly
    res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Pragma, Expires');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

// Test endpoint to verify server is working
app.get('/api/test', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});





// Health check endpoint for frontend to verify server connection
app.get('/api/health', (req, res) => {
  const healthStatus = {
    status: 'ok',
    message: 'Server is healthy',
    timestamp: new Date().toISOString(),
    services: {
      f5tts: {
        running: app.get('narrationServiceRunning') || false,
        port: app.get('narrationActualPort') || null
      },
      chatterbox: {
        running: app.get('chatterboxServiceRunning') || false,
        port: app.get('chatterboxActualPort') || null
      }
    }
  };

  res.json(healthStatus);
});

// Startup mode endpoint - tells frontend which command was used to start the server
app.get('/api/startup-mode', (req, res) => {
  const startupMode = {
    isDevCuda: process.env.START_PYTHON_SERVER === 'true',
    command: process.env.START_PYTHON_SERVER === 'true' ? 'npm run dev:cuda' : 'npm run dev'
  };

  res.json(startupMode);
});

// Endpoint to save localStorage data for server-side use
app.post('/api/save-local-storage', express.json(), (req, res) => {
  try {
    const incomingData = req.body || {};
    const localStoragePath = path.join(process.cwd(), 'localStorage.json');

    // Read existing server-side storage if present
    let existingData = {};
    try {
      if (fs.existsSync(localStoragePath)) {
        const raw = fs.readFileSync(localStoragePath, 'utf-8');
        existingData = JSON.parse(raw || '{}');
      }
    } catch (_) {
      existingData = {};
    }

    // Merge: incoming keys override existing; unspecified keys (like background_* models) are preserved
    const merged = { ...existingData, ...incomingData };

    // Save to a file
    fs.writeFileSync(localStoragePath, JSON.stringify(merged, null, 2));

    res.json({ success: true, message: 'localStorage data saved successfully' });
  } catch (error) {
    console.error('Error saving localStorage data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Register API routes
app.use('/api', videoRoutes);
app.use('/api', subtitleRoutes);
app.use('/api', cacheRoutes);
app.use('/api', updateRoutes);
app.use('/api', lyricsRoutes);
app.use('/api', settingsRoutes);
app.use('/api', douyinRoutes);
app.use('/api', douyinPlaywrightRoutes);
app.use('/api', allSitesRoutes);
app.use('/api', qualityScanRoutes);
app.use('/api', downloadOnlyRoutes);
app.use('/api/download-management', downloadManagementRoutes);
app.use('/api/video', videoCompatibilityRoutes);

app.use('/api/narration', narrationRoutes);
app.use('/api/test', testAudioRoute);
app.use('/api/diagnostics', diagnosticsRoutes);

// Simple model scanning endpoint - no Python bullshit!
app.post('/api/scan-models', async (req, res) => {
  try {
    const success = scanModels();

    if (success) {
      res.json({
        success: true,
        message: 'Models scanned successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to scan models'
      });
    }
  } catch (error) {
    console.error('Error scanning models:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Git branch detection endpoint
app.get('/api/git-branch', (req, res) => {
  const { exec } = require('child_process');
  
  exec('git branch --show-current', (error, stdout, stderr) => {
    if (error) {
      console.error('Error getting git branch:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to detect git branch',
        branch: 'old_version' // Default to old_version if detection fails
      });
    }
    
    const branch = stdout.trim();
    console.log('Current git branch:', branch);
    
    res.json({
      success: true,
      branch: branch || 'old_version'
    });
  });
});

// Git branch switching endpoint
app.post('/api/switch-branch', express.json(), async (req, res) => {
  const { exec } = require('child_process');
  const { branch } = req.body;
  
  if (!branch) {
    return res.status(400).json({
      success: false,
      error: 'Branch name is required'
    });
  }
  
  console.log(`Switching to branch: ${branch}`);
  
  // First, check if the branch exists
  exec(`git branch --list ${branch}`, (error, stdout, stderr) => {
    if (error || !stdout.trim()) {
      console.error(`Branch ${branch} does not exist`);
      return res.status(400).json({
        success: false,
        error: `Branch '${branch}' does not exist. Please create it first.`
      });
    }
    
    // Stash any uncommitted changes first
    exec('git stash', (stashError, stashStdout, stashStderr) => {
      if (stashError) {
        console.warn('Warning: Could not stash changes:', stashError);
      }
      
      // Now checkout the requested branch
      exec(`git checkout ${branch}`, (checkoutError, checkoutStdout, checkoutStderr) => {
        if (checkoutError) {
          console.error('Error switching branch:', checkoutError);
          
          // Try to pop the stash if checkout failed
          exec('git stash pop', () => {});
          
          return res.status(500).json({
            success: false,
            error: `Failed to switch to branch '${branch}': ${checkoutError.message}`
          });
        }
        
        console.log(`Successfully switched to branch: ${branch}`);
        
        // Try to pop the stash after successful checkout
        exec('git stash pop', (popError) => {
          if (popError) {
            console.log('No stashed changes to restore or merge conflict occurred');
          }
        });
        
        // Send success response immediately
        res.json({
          success: true,
          message: `Successfully switched to branch '${branch}'. Restarting application...`,
          branch: branch,
          requiresRestart: true
        });
        
        // Run npm install and then npm run dev/dev:cuda in a new detached process
        setTimeout(() => {
          const { spawn } = require('child_process');
          
          // Check if we're running in Full version (dev:cuda) or Lite version (dev)
          const isFullVersion = process.env.START_PYTHON_SERVER === 'true';
          const runCommand = isFullVersion ? 'npm run dev:cuda' : 'npm run dev';
          
          console.log(`Starting new process with npm install and ${runCommand}...`);
          
          // Create command to run npm install first, then the appropriate dev command
          // Using && to chain commands so dev only runs if install succeeds
          const fullCommand = `npm install && ${runCommand}`;
          
          // Start in a new command window
          spawn('cmd', ['/c', 'start', 'cmd', '/k', fullCommand], {
            detached: true,
            stdio: 'ignore',
            cwd: __dirname,
            shell: false
          }).unref();
          
          console.log(`New process started (${isFullVersion ? 'Full' : 'Lite'} version). This process will exit shortly...`);
          
          // Exit current process after a moment
          setTimeout(() => {
            process.exit(0);
          }, 1000);
        }, 500);
      });
    });
  });
});

module.exports = app;
