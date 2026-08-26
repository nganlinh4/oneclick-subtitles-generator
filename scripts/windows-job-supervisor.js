const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const SUPERVISOR = path.join(__dirname, 'windows-job-supervisor.ps1');

const existingFile = (candidate) => {
  try {
    return fs.statSync(candidate).isFile() ? path.resolve(candidate) : null;
  } catch {
    return null;
  }
};

const windowsEnvironmentValue = (environment, name) => {
  const matches = Object.entries(environment).filter(([key]) => (
    key.localeCompare(name, 'en', { sensitivity: 'accent' }) === 0
  ));
  if (matches.length === 0) return undefined;
  const values = new Set(matches.map(([, value]) => String(value)));
  if (values.size !== 1) {
    throw new Error(`Managed environment contains conflicting ${name} spellings`);
  }
  return matches[0][1];
};

const resolveExecutable = ({ command, cwd, env }) => {
  const explicit = path.isAbsolute(command) || command.includes('/') || command.includes('\\');
  if (explicit) {
    return existingFile(path.isAbsolute(command) ? command : path.resolve(cwd, command));
  }
  const extensions = path.extname(command).length > 0
    ? ['']
    : String(windowsEnvironmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
      .split(';').filter(Boolean);
  for (const directory of String(windowsEnvironmentValue(env, 'PATH') ?? '').split(path.delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const found = existingFile(path.join(directory, `${command}${extension}`));
      if (found !== null) return found;
    }
  }
  return null;
};

const quoteCmdToken = (value) => {
  if (/[\r\n\0]/u.test(value)) {
    throw new Error('Windows batch invocation refuses control characters');
  }
  // Percent expansion happens even inside quotes and can silently change an inherited capability.
  // None of the reviewed managed commands needs it, so refuse rather than invent a lossy escape.
  if (value.includes('%')) {
    throw new Error('Windows batch invocation refuses percent-expanding arguments');
  }
  if (value.includes('"')) {
    throw new Error('Windows batch invocation refuses embedded quote characters');
  }
  return `"${value}"`;
};

const quoteCreateProcessExecutable = (value) => `"${value.replaceAll('"', '\\"')}"`;

const normalizeWindowsInvocation = ({ command, args, cwd, env }) => {
  const executable = resolveExecutable({ command, cwd, env });
  if (executable === null) throw new Error(`Managed executable could not be resolved: ${command}`);
  if (!['.cmd', '.bat'].includes(path.extname(executable).toLowerCase())) {
    return Object.freeze({ command: executable, args });
  }
  const commandInterpreter = resolveExecutable({
    command: windowsEnvironmentValue(env, 'ComSpec')
      ?? path.join(windowsEnvironmentValue(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    cwd,
    env,
  });
  if (commandInterpreter === null || path.extname(commandInterpreter).toLowerCase() !== '.exe') {
    throw new Error('The Windows command interpreter could not be resolved safely');
  }
  const batchCommand = [executable, ...args].map(quoteCmdToken).join(' ');
  return Object.freeze({
    command: commandInterpreter,
    args: Object.freeze([]),
    verbatimCommandLine: [
      quoteCreateProcessExecutable(commandInterpreter),
      '/d', '/s', '/v:off', '/c', 'call', batchCommand,
    ].join(' '),
  });
};

const supervisorArguments = ({
  command, args, cwd, ownerProcessId, verbatimCommandLine = null, managedPaths,
}) => {
  if (!Number.isSafeInteger(ownerProcessId) || ownerProcessId < 1) {
    throw new Error('Windows Job Object supervision requires the live lease-owner process id');
  }
  if (typeof command !== 'string' || command.length === 0 || !path.isAbsolute(command)) {
    throw new Error('Windows Job Object supervision requires an absolute executable path');
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new Error('Windows Job Object supervision requires a string argument array');
  }
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new Error('Windows Job Object supervision requires an absolute working directory');
  }
  if (
    !Array.isArray(managedPaths)
    || managedPaths.length === 0
    || managedPaths.length > 8
    || managedPaths.some((managedPath) => (
      typeof managedPath !== 'string' || !path.isAbsolute(managedPath)
    ))
  ) {
    throw new Error('Windows Job Object supervision requires every leased managed path sentinel');
  }
  const contract = Buffer.from(JSON.stringify({
    executable: command,
    arguments: args,
    cwd,
    verbatimCommandLine,
  }), 'utf8').toString('base64');
  return Object.freeze([
    '-NoProfile',
    '-NonInteractive',
    '-File', SUPERVISOR,
    '-OwnerProcessId', String(ownerProcessId),
    ...managedPaths.flatMap((managedPath, index) => [
      `-ManagedPathSentinel${index + 1}`, managedPath,
    ]),
    '-InvocationBase64', contract,
  ]);
};

const runSupervisedSync = ({
  command,
  args,
  cwd,
  env,
  stdio = 'inherit',
  encoding,
  ownerProcessId = process.pid,
  managedPaths,
  spawn = spawnSync,
}) => {
  if (process.platform !== 'win32') {
    throw new Error('Managed OSG child processes require Windows Job Object supervision');
  }
  const invocation = normalizeWindowsInvocation({ command, args, cwd, env });
  return spawn('pwsh', supervisorArguments({
    command: invocation.command,
    args: invocation.args,
    cwd,
    ownerProcessId,
    verbatimCommandLine: invocation.verbatimCommandLine,
    managedPaths,
  }), {
    cwd,
    env,
    stdio,
    encoding,
    windowsHide: true,
  });
};

module.exports = {
  SUPERVISOR,
  normalizeWindowsInvocation,
  resolveExecutable,
  runSupervisedSync,
  supervisorArguments,
  windowsEnvironmentValue,
};
