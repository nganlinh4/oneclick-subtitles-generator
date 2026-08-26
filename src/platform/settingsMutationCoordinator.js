const activeMutations = new Set();
const resetListeners = new Set();

const projectionNamePattern = /^[a-z][a-zA-Z0-9]{0,63}$/;
const maxProjectionCount = 16;

let resetActive = false;

export class SettingsResetInProgressError extends Error {
  constructor() {
    super('Application settings are being reset');
    this.name = 'SettingsResetInProgressError';
    this.code = 'settingsResetInProgress';
  }
}

const publishResetState = () => {
  resetListeners.forEach((listener) => listener());
};

export const isSettingsResetActive = () => resetActive;

export const subscribeSettingsResetState = (listener) => {
  if (typeof listener !== 'function') {
    throw new TypeError('A settings reset listener is required');
  }
  resetListeners.add(listener);
  return () => resetListeners.delete(listener);
};

/**
 * Own one immediate native-first settings write through its final browser/UI publication.
 *
 * Registration and the reset check are synchronous. Once reset takes ownership no later write can
 * reach native SQLite, and reset cannot clear SQLite/browser mirrors until every earlier write has
 * either published or rejected.
 */
export const runImmediateSettingsMutation = (mutation) => {
  if (typeof mutation !== 'function') {
    return Promise.reject(new TypeError('A settings mutation is required'));
  }
  if (resetActive) {
    return Promise.reject(new SettingsResetInProgressError());
  }

  let pending;
  try {
    pending = Promise.resolve(mutation());
  } catch (error) {
    pending = Promise.reject(error);
  }

  activeMutations.add(pending);
  pending.then(
    () => activeMutations.delete(pending),
    () => activeMutations.delete(pending),
  );
  return pending;
};

/**
 * Commit one setting to native authority, then best-effort every browser/UI projection.
 *
 * A successful native write is durable success. Projection failures are deliberately bounded to
 * stable step names and reported once through `onProjectionWarning`; they never reject the
 * mutation or prevent a later projection from reconciling the current window. Keeping the whole
 * operation inside `runImmediateSettingsMutation` also makes factory reset drain reconciliation
 * before clearing the mirrors it owns.
 */
export const runNativeFirstSettingsMutation = ({
  commitNative,
  committedValue,
  projections = [],
  onProjectionWarning = () => undefined,
}) => {
  if (typeof commitNative !== 'function') {
    return Promise.reject(new TypeError('A native settings commit is required'));
  }
  if (!Array.isArray(projections) || projections.length > maxProjectionCount
      || projections.some(({ name, project } = {}) => (
        typeof name !== 'string'
        || !projectionNamePattern.test(name)
        || typeof project !== 'function'
      ))
      || new Set(projections.map(({ name }) => name)).size !== projections.length) {
    return Promise.reject(new TypeError('Bounded unique settings projections are required'));
  }
  if (typeof onProjectionWarning !== 'function') {
    return Promise.reject(new TypeError('A settings projection warning callback is required'));
  }

  return runImmediateSettingsMutation(async () => {
    await commitNative();

    const failedProjections = [];
    for (const { name, project } of projections) {
      try {
        await project(committedValue);
      } catch {
        failedProjections.push(name);
      }
    }

    if (failedProjections.length > 0) {
      const warning = Object.freeze({
        status: 'committed-with-projection-warning',
        value: committedValue,
        failedProjections: Object.freeze(failedProjections),
      });
      try {
        await onProjectionWarning(warning);
      } catch {
        // A toast or telemetry sink is another projection, never a reason to retry a durable write.
      }
    }

    // Preserve the existing preference API: callers still receive the committed primitive value.
    return committedValue;
  });
};

/**
 * Block new immediate writes, drain all writes that already own the coordinator, then reset.
 * Rejected writes are considered settled and do not strand reset. Reset failure releases ownership
 * so the still-running application can save again instead of remaining permanently read-only.
 */
const runSettingsReset = async (reset, { terminal }) => {
  if (typeof reset !== 'function') {
    throw new TypeError('A settings reset operation is required');
  }
  if (resetActive) {
    throw new SettingsResetInProgressError();
  }

  resetActive = true;
  let retainOwnership = false;
  try {
    publishResetState();
    await Promise.allSettled([...activeMutations]);
    try {
      return await reset();
    } finally {
      // A destructive reset may have cleared only part of the application before reporting an
      // error. Its old document must never become writable again; navigation destroys this module
      // and creates the next idle coordinator from cleanly hydrated state.
      retainOwnership = terminal;
    }
  } finally {
    if (!retainOwnership) {
      resetActive = false;
      publishResetState();
    }
  }
};

export const runExclusiveSettingsReset = (reset) => runSettingsReset(reset, {
  terminal: false,
});

export const runTerminalSettingsReset = (reset) => runSettingsReset(reset, {
  terminal: true,
});
