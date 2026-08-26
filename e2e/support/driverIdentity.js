import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

/* global AbortSignal */

const FORBIDDEN_FIXED_PORT = 4_445;
const MINIMUM_EPHEMERAL_PORT = 49_152;
const IDENTITY_PATTERN = /^[0-9a-f]{64}$/u;
const SERVER_MARKER = 'osg-guarded-wdio-webdriver';

const listenOnFreshLoopbackPort = () => new Promise((resolve, reject) => {
  const reservation = createServer();
  reservation.unref();
  reservation.once('error', reject);
  reservation.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
    const address = reservation.address();
    reservation.close((error) => {
      if (error) reject(error);
      else if (typeof address !== 'object' || address === null) reject(new Error('no loopback port'));
      else resolve(address.port);
    });
  });
});

export const isGuardedWebDriverIdentity = (value) => (
  typeof value === 'string' && IDENTITY_PATTERN.test(value)
);

export const createGuardedWebDriverBinding = async ({
  environment, runRoot, workerProcess = false,
}) => {
  const inheritedPort = Number(environment.TAURI_WEBDRIVER_PORT);
  const inheritedIdentity = environment.OSG_E2E_WEBDRIVER_IDENTITY;
  const inheritedAuthorization = environment.OSG_E2E_WEBDRIVER_AUTHORIZATION;
  if (
    workerProcess
    && typeof environment.WDIO_WORKER_ID === 'string'
    && environment.WDIO_WORKER_ID.length > 0
    && environment.OSG_E2E_WEBDRIVER_RUN_ROOT === runRoot
    && Number.isSafeInteger(inheritedPort)
    && inheritedPort >= MINIMUM_EPHEMERAL_PORT
    && inheritedPort !== FORBIDDEN_FIXED_PORT
    && isGuardedWebDriverIdentity(inheritedIdentity)
    && isGuardedWebDriverIdentity(inheritedAuthorization)
    && inheritedAuthorization !== inheritedIdentity
  ) {
    return Object.freeze({
      authorization: inheritedAuthorization,
      identity: inheritedIdentity,
      port: inheritedPort,
      runRoot,
    });
  }

  let port;
  do {
    port = await listenOnFreshLoopbackPort();
  } while (port < MINIMUM_EPHEMERAL_PORT || port === FORBIDDEN_FIXED_PORT);
  return Object.freeze({
    authorization: randomBytes(32).toString('hex'),
    identity: randomBytes(32).toString('hex'),
    port,
    runRoot,
  });
};

export const guardedWebDriverEnvironment = (binding) => Object.freeze({
  OSG_E2E_WEBDRIVER_AUTHORIZATION: binding.authorization,
  OSG_E2E_WEBDRIVER_IDENTITY: binding.identity,
  OSG_E2E_WEBDRIVER_RUN_ROOT: binding.runRoot,
  TAURI_WEBDRIVER_PORT: String(binding.port),
});

export const assertGuardedWebDriverStatus = (payload, binding) => {
  const status = payload?.value;
  if (
    status?.ready !== true
    || status?.server !== SERVER_MARKER
    || status?.osgE2eIdentity !== binding.identity
    || !Number.isSafeInteger(status?.processId)
    || status.processId <= 0
  ) {
    throw new Error(
      `refusing a foreign, stale, or unguarded WebDriver server on loopback port ${binding.port}`,
    );
  }
  return Object.freeze({ processId: status.processId });
};

export const verifyGuardedWebDriverStatus = async (binding, fetchImplementation = globalThis.fetch) => {
  const response = await fetchImplementation(`http://127.0.0.1:${binding.port}/status`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`guarded WebDriver status returned HTTP ${response.status}`);
  }
  return assertGuardedWebDriverStatus(await response.json(), binding);
};

export const assertGuardedWebDriverSession = (capabilities, binding, processId) => {
  if (
    capabilities?.['osg:e2eIdentity'] !== binding.identity
    || capabilities?.['osg:e2eProcessId'] !== processId
  ) {
    throw new Error('the WebDriver session did not echo the current guarded process identity');
  }
};

const FORBIDDEN_INTERACTIVE_COMMANDS = new Set([
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
]);

export const assertWebDriverCommandIsNonInteractive = (commandName) => {
  if (FORBIDDEN_INTERACTIVE_COMMANDS.has(commandName)) {
    throw new Error(`the hidden harness refused interactive command ${commandName}`);
  }
};
