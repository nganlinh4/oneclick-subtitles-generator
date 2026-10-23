/**
 * Factory-reset plumbing: clears native state, browser storage and IndexedDB, then reloads.
 * Each operation is idempotent and retried once before the reset reports failure.
 */
import { clearCache } from '../../../platform/cacheService';
import { clearCredentials } from '../../../platform/credentialStateController';
import { clearMedia } from '../../../platform/mediaService';
import { clearDesktopSettings } from '../../../platform/settingsService';

const startResetOperation = (operation) => {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
};

const runIdempotentResetOperations = async (operations, { attempts = 2 } = {}) => {
  const values = new Array(operations.length);
  let remaining = operations.map((operation, index) => ({ operation, index }));
  let lastFailures = [];

  for (let attempt = 0; attempt < attempts && remaining.length > 0; attempt += 1) {
    const batch = remaining;
    const results = await Promise.allSettled(batch.map(
      ({ operation }) => startResetOperation(operation),
    ));
    const failed = [];
    results.forEach((result, batchIndex) => {
      const { operation, index } = batch[batchIndex];
      if (result.status === 'fulfilled') {
        values[index] = result.value;
      } else {
        failed.push({ operation, index });
      }
    });
    lastFailures = results.filter((result) => result.status === 'rejected');
    remaining = failed;
  }

  if (remaining.length > 0) {
    throw lastFailures[0].reason;
  }
  return values;
};

export const clearNativeApplicationState = () => runIdempotentResetOperations([
  () => clearCache(),
  () => clearCredentials(),
  () => clearMedia(),
  () => clearDesktopSettings(),
]);

const waitForIndexedDbDeletion = (indexedDb, name) => new Promise((resolve, reject) => {
  const request = indexedDb.deleteDatabase(name);
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error ?? new Error('IndexedDB reset failed'));
  request.onblocked = () => reject(new Error('IndexedDB reset was blocked'));
});

export const clearBrowserApplicationState = async ({
  storage = globalThis.localStorage,
  indexedDb = globalThis.indexedDB,
} = {}) => {
  const [databases] = await runIdempotentResetOperations([
    () => indexedDb.databases(),
  ]);
  const databaseNames = databases
    .map((database) => database?.name)
    .filter((name) => typeof name === 'string' && name.length > 0);

  storage.clear();
  await runIdempotentResetOperations(databaseNames.map(
    (name) => () => waitForIndexedDbDeletion(indexedDb, name),
  ));
};

export const clearApplicationStateAndReload = async ({
  clearNative = clearNativeApplicationState,
  clearBrowser = clearBrowserApplicationState,
  reload = () => window.location.reload(),
} = {}) => {
  let resetFailure = null;
  try {
    await runIdempotentResetOperations([clearNative, clearBrowser]);
  } catch (error) {
    resetFailure = error;
  }

  // Navigation is the recovery boundary for both success and partial failure. The terminal
  // coordinator keeps the old document read-only if the host does not destroy it immediately.
  reload();
  if (resetFailure) throw resetFailure;
};
