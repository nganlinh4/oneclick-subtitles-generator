#!/usr/bin/env node

const { assertFrontendInnerInvocation } = require('./managed-build-context');

try {
  assertFrontendInnerInvocation();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
