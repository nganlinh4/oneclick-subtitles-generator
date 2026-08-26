#!/usr/bin/env node

const path = require('node:path');
const { assertManagedBuildInvocation } = require('./managed-build-context');

const assertManagedTauriInvocation = ({
  environment = process.env,
  repositoryRoot = path.resolve(__dirname, '..'),
  isProcessAlive,
} = {}) => {
  if (!environment.CARGO_TARGET_DIR && !environment.OSG_MANAGED_FRONTEND_ROOT) {
    throw new Error('Local Tauri commands must run through the root managed-cache scripts');
  }
  return assertManagedBuildInvocation({ environment, repositoryRoot, isProcessAlive }).group;
};

if (require.main === module) {
  try {
    assertManagedTauriInvocation();
    require('@tauri-apps/cli/tauri.js');
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { assertManagedTauriInvocation };
