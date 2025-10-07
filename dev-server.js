const { spawn } = require('child_process');
const chalk = require('chalk');

// Import port management for cleanup and CORS setup
const { killProcessesOnPorts, cleanupTrackingFile } = require('./server/utils/portManager');
const { setupEnvironmentVariables } = require('./scripts/setup-cors-env');

// Colors for different services
const colors = {
  FRONTEND: chalk.cyan,
  SERVER: chalk.green,
  RENDERER: chalk.magenta,
  MIDI: chalk.blue
};

// Commands to run - cross-platform approach
const commands = [
  { name: 'FRONTEND', cmd: 'npm', args: ['run', 'start'], cwd: '.' },
  { name: 'SERVER', cmd: 'npm', args: ['run', 'server:start'], cwd: '.' },
  { name: 'RENDERER', cmd: 'npm', args: ['run', 'video-renderer:start'], cwd: '.' },
  { name: 'MIDI', cmd: 'npm', args: ['run', 'dev', '--silent'], cwd: './promptdj-midi' }
];

// Function to prefix output with colored service name (only the prefix is colored)
function prefixOutput(serviceName, data) {
  const color = colors[serviceName];
  const lines = data.toString().split('\n');
  return lines
    .filter(line => line.trim() !== '')
    .map(line => `${color(`[${serviceName}]`)} ${line}`)
    .join('\n');
}

// Start all services with proper sequencing
async function startServices() {
  console.log(chalk.bold('Starting development servers...\n'));

  // Setup CORS environment variables
  console.log(chalk.yellow('🔧 Setting up CORS configuration...'));
  setupEnvironmentVariables();
  console.log(chalk.green('✅ CORS configuration complete\n'));

  // First, clean up ports
  console.log(chalk.yellow('🧹 Cleaning up ports before starting services...'));
  cleanupTrackingFile();
  await killProcessesOnPorts();
  console.log(chalk.green('✅ Port cleanup complete\n'));

  // Wait a moment for ports to be fully released
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Now start all services
  commands.forEach(({ name, cmd, args, cwd }) => {
    const childProcess = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true, // Use shell: true for cross-platform npm compatibility (works on Windows, Linux, macOS)
      cwd: cwd,
      env: {
        ...process.env,
        DEV_SERVER_MANAGED: 'true' // Tell services they're managed by dev-server
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
      console.log(color(`[${name}] Process exited with code ${code}`));
    });

    childProcess.on('error', (err) => {
      const color = colors[name];
      console.log(color(`[${name}] Error: ${err.message}`));
    });
  });
}

// Start services
startServices().catch(error => {
  console.error(chalk.red('❌ Error starting services:', error));
  process.exit(1);
});

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log(chalk.yellow('\nShutting down development servers...'));
  process.exit(0);
});
