/**
 * Install Playwright browsers needed by the Douyin downloader (chromium + headless shell)
 * Ensures both OSG Lite and OSG Full have required browser binaries after `npm install`.
 *
 * This script is safe to run multiple times and will no-op if browsers are already installed.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Logger } = require('./utils/logger');

// Set VERBOSE to true for detailed output
process.env.VERBOSE = "true";

const logger = new Logger({
  verbose: process.env.VERBOSE === 'true',
  quiet: process.env.QUIET === 'true'
});

function commandExists(command) {
  try {
    const base = command.split(' ')[0];
    const checkCmd = process.platform === 'win32' ? `where ${base}` : `command -v ${base}`;
    execSync(checkCmd, { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

(function main() {
  logger.section('Browser automation setup (Playwright)');

  try {
    // Determine Playwright CLI
    const bin = path.join(__dirname, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
    let cli = '';

    if (fs.existsSync(bin)) {
      cli = `"${bin}"`;
      logger.found('Playwright CLI', 'using local node_modules/.bin');
    } else if (commandExists('npx')) {
      cli = 'npx playwright';
      logger.found('npx', 'will use npx to run Playwright CLI');
    } else {
      logger.warning('Neither local Playwright CLI nor npx is available. Skipping Playwright browser install.');
      logger.info('To enable Douyin downloads, run later: npx playwright install chromium chromium-headless-shell');
      return; // Non-fatal
    }

    const installCmd = `${cli} install chromium chromium-headless-shell`;
    logger.command(installCmd);
    execSync(installCmd, { stdio: logger.verboseMode ? 'inherit' : 'pipe' });
    logger.success('Playwright browsers installed (chromium + headless_shell)');
  } catch (error) {
    // Do not hard-fail the whole npm install; just warn clearly
    logger.warning(`Playwright browser installation failed: ${error.message}`);
    logger.info('Douyin downloads via Playwright may fail until browsers are installed.');
    logger.info('Try manually: npx playwright install chromium chromium-headless-shell');
  }
})();

