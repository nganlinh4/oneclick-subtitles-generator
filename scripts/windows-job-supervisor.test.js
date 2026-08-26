const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  normalizeWindowsInvocation, runSupervisedSync, supervisorArguments,
} = require('./windows-job-supervisor');

const waitUntil = async (predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the supervised process state');
};

const processExists = (processId) => {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
};

test('supervisor contract is opaque and preserves an exact absolute invocation', () => {
  const invocation = normalizeWindowsInvocation({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    cwd: process.cwd(),
    env: process.env,
  });
  const args = supervisorArguments({
    ...invocation,
    cwd: process.cwd(),
    ownerProcessId: process.pid,
    managedPaths: [process.cwd()],
  });
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-File']);
  const encoded = args[args.indexOf('-InvocationBase64') + 1];
  const contract = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  assert.equal(contract.executable, process.execPath);
  assert.deepEqual(contract.arguments, ['-e', 'process.exit(0)']);
  assert.equal(contract.cwd, process.cwd());
});

test('executable lookup follows Windows environment casing after object spread', () => {
  const environment = {
    Path: path.dirname(process.execPath),
    PathExt: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: process.env.SystemRoot,
  };
  const invocation = normalizeWindowsInvocation({
    command: path.basename(process.execPath, path.extname(process.execPath)),
    args: ['--version'],
    cwd: process.cwd(),
    env: environment,
  });
  assert.equal(invocation.command.toLowerCase(), process.execPath.toLowerCase());
  assert.throws(
    () => normalizeWindowsInvocation({
      command: 'node',
      args: [],
      cwd: process.cwd(),
      env: { ...environment, PATH: 'C:\\conflicting' },
    }),
    /conflicting PATH spellings/u,
  );
});

test('supervised child stdout and exit status propagate through the Job Object owner', () => {
  const result = runSupervisedSync({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("supervised"); process.exit(7)'],
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    managedPaths: [process.cwd()],
  });
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'supervised');
  assert.equal(result.stderr, '');
});

test('killing the lease owner closes the Job Object and kills child and grandchild', async (context) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-job-supervisor-test-'));
  context.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const identityPath = path.join(scratch, 'identity.json');
  const managedSentinel = path.join(scratch, 'managed-lane');
  fs.mkdirSync(managedSentinel);
  const grandchildSource = 'setInterval(() => {}, 1000)';
  const childSource = [
    'const {spawn}=require("node:child_process");',
    'const fs=require("node:fs");',
    `const grandchild=spawn(process.execPath,["-e",${JSON.stringify(grandchildSource)}],{stdio:"ignore",windowsHide:true});`,
    `fs.writeFileSync(${JSON.stringify(identityPath)},JSON.stringify({child:process.pid,grandchild:grandchild.pid}));`,
    'setInterval(() => {}, 1000);',
  ].join('');
  const supervisorModule = path.join(__dirname, 'windows-job-supervisor.js');
  const ownerSource = [
    `const {runSupervisedSync}=require(${JSON.stringify(supervisorModule)});`,
    `runSupervisedSync({command:process.execPath,args:["-e",${JSON.stringify(childSource)}],`,
    `cwd:process.cwd(),env:process.env,stdio:"ignore",managedPaths:[${JSON.stringify(managedSentinel)}]});`,
  ].join('');
  const owner = spawn(process.execPath, ['-e', ownerSource], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'ignore',
    windowsHide: true,
  });
  context.after(() => {
    if (processExists(owner.pid)) owner.kill('SIGKILL');
  });
  await waitUntil(() => fs.existsSync(identityPath));
  const identities = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  assert.equal(processExists(identities.child), true);
  assert.equal(processExists(identities.grandchild), true);
  const query = spawnSync('pwsh', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${owner.pid}').CommandLine`,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(query.status, 0, query.stderr);
  const commandLine = query.stdout;
  assert.match(commandLine, new RegExp(managedSentinel.replaceAll('\\', '\\\\'), 'iu'));
  owner.kill('SIGKILL');
  await waitUntil(() => !processExists(identities.child) && !processExists(identities.grandchild));
});
