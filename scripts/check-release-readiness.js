#!/usr/bin/env node
'use strict';

// Release-readiness gate. The checks live in scripts/release-readiness/; this entry keeps the CLI:
//   node scripts/check-release-readiness.js [--profile compile|host-toolchain|runtime-package] [--target <triple>]

const {
  checkCompileReadiness,
  checkRuntimePackageReadiness,
  parseArguments,
} = require('./release-readiness/profiles');
const { REPOSITORY_ROOT } = require('./release-readiness/shared');
const { checkHostToolchain } = require('./release-readiness/toolchains');

function run(profile, target) {
  if (profile === 'compile') {
    const report = checkCompileReadiness();
    return `Compile readiness passed: Node ${report.nodeVersion}, ${report.packageManager}, Rust ${report.rustVersion}, Tauri CLI ${report.tauriCliVersion}, ${report.resourceCount} runtime resources.`;
  }
  if (profile === 'host-toolchain') {
    const report = checkHostToolchain();
    return `Effective toolchain passed: Node ${report.nodeVersion}, npm ${report.npmVersion}, Python ${report.pythonVersion}, Rust ${report.rustVersion}.`;
  }
  const report = checkRuntimePackageReadiness(REPOSITORY_ROOT, target);
  return `Runtime-package readiness passed for ${report.target}: ${report.resourceCount} validated resources.`;
}

if (require.main === module) {
  try {
    const { profile, target } = parseArguments(process.argv.slice(2));
    console.log(run(profile, target));
  } catch (error) {
    const label = process.argv.includes('runtime-package')
      ? 'Runtime-package'
      : process.argv.includes('host-toolchain') ? 'Host-toolchain' : 'Compile';
    console.error(`${label} readiness failed: ${error.message}`);
    process.exitCode = 1;
  }
}
