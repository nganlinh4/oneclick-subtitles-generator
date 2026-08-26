import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..');
const clearedEnvironment = () => {
  const environment = { ...process.env };
  for (const name of [
    'CARGO_TARGET_DIR', 'CI', 'GITHUB_ACTIONS', 'GITHUB_JOB', 'GITHUB_RUN_ATTEMPT',
    'GITHUB_RUN_ID', 'GITHUB_SHA', 'GITHUB_WORKSPACE', 'OSG_DEV_CACHE_ROOT',
    'OSG_FRONTEND_OUT_DIR', 'OSG_MANAGED_APPLICATION_ROOT', 'OSG_MANAGED_FRONTEND_ROOT',
    'OSG_MANAGED_LANE', 'OSG_MANAGED_LEASE_ID', 'OSG_MANAGED_LEASE_PROCESS_CREATED_UTC',
    'OSG_MANAGED_LEASE_PROCESS_ID', 'OSG_PROMPTDJ_OUT_DIR', 'OSG_VERSION_MODULE_PATH',
    'RUNNER_OS', 'RUNNER_TEMP', 'TAURI_CONFIG',
  ]) delete environment[name];
  return environment;
};

const runModule = (source, environment) => spawnSync(
  process.execPath,
  ['--input-type=module', '--eval', source],
  { cwd: repositoryRoot, env: environment, encoding: 'utf8', windowsHide: true },
);

test('both Vite configs reject unmanaged local inner execution', () => {
  const environment = clearedEnvironment();
  const main = runModule(
    "const config=(await import('./vite.config.mjs')).default; config({mode:'production'});",
    environment,
  );
  assert.notEqual(main.status, 0);
  assert.match(main.stderr, /validated GitHub Actions workspace/u);

  const promptDj = runModule(
    "const {loadConfigFromFile}=await import('vite'); await loadConfigFromFile({command:'build',mode:'production'},'promptdj-midi/vite.config.ts');",
    environment,
  );
  assert.notEqual(promptDj.status, 0);
  assert.match(promptDj.stderr, /validated GitHub Actions workspace/u);
});

test('the explicit CI inner route accepts a complete GitHub Actions identity', () => {
  const environment = {
    ...clearedEnvironment(),
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_JOB: 'native-matrix',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '123456789',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKSPACE: repositoryRoot,
    RUNNER_OS: 'Windows',
    RUNNER_TEMP: resolve(tmpdir(), 'osg-runner-temp'),
  };
  const main = runModule(
    "const config=(await import('./vite.config.mjs')).default; const value=config({mode:'production'}); if(value.build.outDir!=='build') process.exit(7);",
    environment,
  );
  assert.equal(main.status, 0, main.stderr);

  const promptDj = runModule(
    "const {loadConfigFromFile}=await import('vite'); const value=await loadConfigFromFile({command:'build',mode:'production'},'promptdj-midi/vite.config.ts'); if(value.config.build!==undefined) process.exit(8);",
    environment,
  );
  assert.equal(promptDj.status, 0, promptDj.stderr);
});
