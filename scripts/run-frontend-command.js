#!/usr/bin/env node

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  assertManagedBuildInvocation,
  hasManagedLeaseIdentity,
} = require('./managed-build-context');

const parseArguments = (arguments_) => {
  if (arguments_[0] !== '--lane' || arguments_[1] !== 'dev' || arguments_[2] !== '--') {
    throw new Error('frontend command requires --lane dev -- followed by one command');
  }
  if (typeof arguments_[3] !== 'string' || arguments_[3].length === 0) {
    throw new Error('frontend command requires one child command');
  }
  return Object.freeze({ command: arguments_[3], args: Object.freeze(arguments_.slice(4)) });
};

const spawnChecked = ({ command, args, cwd, environment, spawn = spawnSync }) => {
  const executable = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
  const result = spawn(executable, args, {
    cwd,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${path.basename(executable)} exited with ${result.status}`);
    error.exitCode = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
    throw error;
  }
  return result;
};

const runFrontendCommand = ({
  arguments_: commandLine = process.argv.slice(2),
  environment = process.env,
  repositoryRoot = path.resolve(__dirname, '..'),
  spawn = spawnSync,
  isProcessAlive,
} = {}) => {
  const invocation = parseArguments(commandLine);
  const repository = path.resolve(repositoryRoot);
  if (hasManagedLeaseIdentity(environment)) {
    assertManagedBuildInvocation({ environment, repositoryRoot: repository, isProcessAlive });
    return spawnChecked({
      command: invocation.command,
      args: invocation.args,
      cwd: repository,
      environment,
      spawn,
    });
  }
  return spawnChecked({
    command: process.execPath,
    args: [
      path.join(repository, 'scripts', 'run-managed-command.js'),
      '--lane', 'dev', '--', invocation.command, ...invocation.args,
    ],
    cwd: repository,
    environment,
    spawn,
  });
};

if (require.main === module) {
  try {
    runFrontendCommand();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}

module.exports = { parseArguments, runFrontendCommand, spawnChecked };
