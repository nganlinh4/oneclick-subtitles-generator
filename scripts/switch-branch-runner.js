#!/usr/bin/env node

// This script runs in a NEW terminal window to switch git branch and restart services
// It ensures the current running app is not disrupted by file changes during the switch.

const { exec } = require('child_process');
const path = require('path');

const branch = process.argv[2];
if (!branch) {
  console.error('Branch name required');
  process.exit(1);
}

const isFullVersion = process.env.START_PYTHON_SERVER === 'true';
const runCommand = isFullVersion ? 'npm run dev:cuda' : 'npm run dev';

function run(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { cwd: process.cwd(), ...opts }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) return reject(err);
      resolve();
    });
  });
}

(async () => {
  try {
    console.log(`[SWITCHER] Preparing to switch to branch: ${branch}`);

    // Optional: clear caches to minimize interference
    try {
      await run('node scripts/clear-cache.js');
    } catch (_) {}

    console.log('[SWITCHER] Fetching remote branches...');
    await run('git fetch origin');

    console.log('[SWITCHER] Verifying remote branch exists...');
    await run(`git ls-remote --heads origin ${branch}`).catch(() => {
      throw new Error(`Branch '${branch}' does not exist on the remote repository.`);
    });

    console.log('[SWITCHER] Stashing local changes (if any)...');
    try { await run('git stash'); } catch (_) {}

    console.log(`[SWITCHER] Checking out branch '${branch}' from origin...`);
    await run(`git checkout -B ${branch} origin/${branch}`);

    console.log('[SWITCHER] Restoring stashed changes (if any)...');
    try { await run('git stash pop'); } catch (_) { console.log('[SWITCHER] No stashed changes to restore or conflicts occurred.'); }

    console.log('[SWITCHER] Installing dependencies...');
    await run('npm install');

    console.log(`[SWITCHER] Starting services with: ${runCommand}`);
    // Start the dev process; inherit stdio so window remains active
    const { spawn } = require('child_process');
    const child = spawn(runCommand, { shell: true, stdio: 'inherit' });
    child.on('exit', (code) => {
      console.log(`[SWITCHER] Child process exited with code ${code}`);
      process.exit(code ?? 0);
    });
  } catch (err) {
    console.error(`[SWITCHER] Failed: ${err.message}`);
    process.exit(1);
  }
})();

