#!/usr/bin/env node

// This script runs in a NEW terminal window to switch git branch and restart services
// It ensures the current running app is not disrupted by file changes during the switch.

const { exec } = require('child_process');

const branch = process.argv[2];
if (!branch) {
  console.error('Branch name required');
  process.exit(1);
}

const isFullVersion = process.env.START_PYTHON_SERVER === 'true';
const runCommand = isFullVersion ? 'npm run dev:cuda' : 'npm run dev';

function run(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: process.cwd(), ...opts }, (err, stdout, stderr) => {
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

    // Save any local changes safely to a stash, but DO NOT auto-apply it later.
    const stashMessage = `auto-switch-${branch}-${Date.now()}`;
    console.log('[SWITCHER] Stashing local changes (kept for reference, not re-applied)...');
    try { await run(`git stash push -u -m "${stashMessage}"`); } catch (_) {}

    console.log(`[SWITCHER] Checking out branch '${branch}' from origin...`);
    await run(`git checkout -B ${branch} origin/${branch}`);

    // Ensure working tree matches the target branch exactly to avoid any merge conflicts
    console.log('[SWITCHER] Resetting working tree to match remote branch (discarding local differences for this workspace)...');
    await run(`git reset --hard origin/${branch}`);
    await run('git clean -fd');

    console.log('[SWITCHER] Installing dependencies...');
    await run('npm install');

    console.log(`[SWITCHER] Starting services with: ${runCommand}`);
    // Start the dev process; inherit stdio so window remains active
    const { spawn } = require('child_process');
    const child = spawn(runCommand, { shell: true, stdio: 'inherit' });
    child.on('exit', (code) => {
      console.log(`[SWITCHER] Child process exited with code ${code}`);
      if (code === 0) {
        console.log(`[SWITCHER] Local changes (if any) were saved in stash: "${stashMessage}". You can inspect with 'git stash list'.`);
      }
      process.exit(code ?? 0);
    });
  } catch (err) {
    console.error(`[SWITCHER] Failed: ${err.message}`);
    console.error(`[SWITCHER] If you had local changes, they may be stored in 'git stash list'.`);
    process.exit(1);
  }
})();

