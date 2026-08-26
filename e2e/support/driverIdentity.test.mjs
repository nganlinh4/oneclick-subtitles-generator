import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  assertGuardedWebDriverSession,
  assertGuardedWebDriverStatus,
  assertWebDriverCommandIsNonInteractive,
  createGuardedWebDriverBinding,
  guardedWebDriverEnvironment,
  verifyGuardedWebDriverStatus,
} from './driverIdentity.js';

const withStatusServer = async (port, payload, body) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    await body();
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
};

test('each launcher owns a high random binding while its worker reuses only that exact run', async () => {
  const first = await createGuardedWebDriverBinding({ environment: {}, runRoot: 'run-a' });
  assert.ok(first.port >= 49_152);
  assert.notEqual(first.port, 4_445);
  assert.match(first.identity, /^[0-9a-f]{64}$/u);
  assert.match(first.authorization, /^[0-9a-f]{64}$/u);
  assert.notEqual(first.authorization, first.identity);

  const environment = {
    ...guardedWebDriverEnvironment(first),
    WDIO_WORKER_ID: '0-0',
  };
  const worker = await createGuardedWebDriverBinding({
    environment, runRoot: 'run-a', workerProcess: true,
  });
  assert.deepEqual(worker, first);
  const ambientDirectLaunch = await createGuardedWebDriverBinding({
    environment, runRoot: 'run-a', workerProcess: false,
  });
  assert.notEqual(ambientDirectLaunch.identity, first.identity);

  const foreignRun = await createGuardedWebDriverBinding({ environment, runRoot: 'run-b' });
  assert.notEqual(foreignRun.identity, first.identity);
  const fixedAmbient = await createGuardedWebDriverBinding({
    environment: {
      OSG_E2E_WEBDRIVER_AUTHORIZATION: 'b'.repeat(64),
      OSG_E2E_WEBDRIVER_IDENTITY: 'a'.repeat(64),
      OSG_E2E_WEBDRIVER_RUN_ROOT: 'run-a',
      TAURI_WEBDRIVER_PORT: '4445',
    },
    runRoot: 'run-a',
  });
  assert.notEqual(fixedAmbient.port, 4_445);
  assert.notEqual(fixedAmbient.identity, 'a'.repeat(64));
  assert.notEqual(fixedAmbient.authorization, 'b'.repeat(64));
});

test('a stale ready server is rejected before session creation or window commands', async () => {
  const binding = await createGuardedWebDriverBinding({ environment: {}, runRoot: 'stale-run' });
  await withStatusServer(binding.port, {
    value: { ready: true, message: 'some unrelated WebDriver' },
  }, async () => {
    await assert.rejects(
      verifyGuardedWebDriverStatus(binding),
      /foreign, stale, or unguarded WebDriver/u,
    );
  });
});

test('status and session identity require the exact guarded process response', async () => {
  const binding = await createGuardedWebDriverBinding({ environment: {}, runRoot: 'guarded-run' });
  const payload = {
    value: {
      osgE2eIdentity: binding.identity,
      processId: 1234,
      ready: true,
      server: 'osg-guarded-wdio-webdriver',
    },
  };
  assert.deepEqual(assertGuardedWebDriverStatus(payload, binding), { processId: 1234 });
  await withStatusServer(binding.port, payload, async () => {
    assert.deepEqual(await verifyGuardedWebDriverStatus(binding), { processId: 1234 });
  });

  assert.doesNotThrow(() => assertGuardedWebDriverSession({
    'osg:e2eIdentity': binding.identity,
    'osg:e2eProcessId': 1234,
  }, binding, 1234));
  assert.throws(
    () => assertGuardedWebDriverSession({
      'osg:e2eIdentity': binding.identity,
      'osg:e2eProcessId': 9999,
    }, binding, 1234),
    /did not echo/u,
  );
});

test('the client refuses every standard native-surface and navigation mutation command', () => {
  for (const command of [
    'back',
    'forward',
    'fullscreenWindow',
    'maximizeWindow',
    'minimizeWindow',
    'newWindow',
    'refresh',
    'setWindowPosition',
    'setWindowRect',
    'setWindowSize',
    'url',
  ]) {
    assert.throws(() => assertWebDriverCommandIsNonInteractive(command), command);
  }
  for (const command of ['click', 'executeScript', 'getWindowRect', 'takeScreenshot']) {
    assert.doesNotThrow(() => assertWebDriverCommandIsNonInteractive(command));
  }
});
