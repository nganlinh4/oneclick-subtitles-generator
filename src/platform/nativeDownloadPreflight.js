import i18n from '../i18n/i18n';
import {
  getNativeToolsCatalog,
  getNativeToolsStatus,
  installNativeTool,
} from './nativeToolsService';

const MANAGED_DOWNLOAD_TOOL_IDS = Object.freeze(['media-tools', 'yt-dlp', 'deno']);
const TOOL_PROGRESS_TOAST_KEY = 'native-download-tool-preflight';
const toolProgressToastKey = (toolId) => `${TOOL_PROGRESS_TOAST_KEY}:${toolId}`;
const PROGRESS_STEP_PERCENT = 5;
const DEFAULT_INSTALL_TIMEOUT_MS = 60 * 60 * 1_000;
const AUTO_UPDATE_COOLDOWN_MS = 30 * 60 * 1_000;

const isRecord = (value) => value !== null && typeof value === 'object';

const safeCall = (callback, ...args) => {
  if (typeof callback !== 'function') return;
  try {
    callback(...args);
  } catch {
    // Presentation callbacks cannot change the native operation lifecycle.
  }
};

const defaultPresentation = Object.freeze({
  notify: ({ message, type, duration, key, button }) => {
    if (typeof window !== 'undefined' && typeof window.addToast === 'function') {
      window.addToast(message, type, duration, key, button);
    }
  },
  dismiss: (key) => {
    if (typeof window !== 'undefined' && typeof window.removeToastByKey === 'function') {
      window.removeToastByKey(key);
    }
  },
});

export class NativeDownloadPreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeDownloadPreflightError';
    this.code = code;
  }
}

const failure = (code, message) => new NativeDownloadPreflightError(code, message);

const validateOptions = (options) => {
  if (options === undefined) return Object.freeze({});
  if (!isRecord(options) || Array.isArray(options)) {
    throw failure('invalidNativeToolPreflight', 'The native tool preflight request is invalid');
  }
  const keys = Object.keys(options);
  if (keys.some((key) => !['signal', 'onJobStarted', 'onProgress'].includes(key))
      || (options.onJobStarted !== undefined && typeof options.onJobStarted !== 'function')
      || (options.onProgress !== undefined && typeof options.onProgress !== 'function')) {
    throw failure('invalidNativeToolPreflight', 'The native tool preflight request is invalid');
  }
  const { signal } = options;
  if (signal !== undefined
      && (!isRecord(signal)
        || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function')) {
    throw failure('invalidNativeToolPreflight', 'The native tool preflight request is invalid');
  }
  return options;
};

const localizedFailure = (code, t) => {
  const messages = {
    nativeToolCancelled: t('download.nativeTools.cancelled'),
    nativeToolCorrupt: t('download.nativeTools.corrupt'),
    nativeToolHealthFailed: t('download.nativeTools.healthFailed'),
    nativeToolUnavailable: t('download.nativeTools.deliveryUnavailable'),
    nativeMediaToolsUnavailable: t('download.nativeTools.mediaToolsUnavailable'),
    nativeDownloadUnavailable: t('download.nativeTools.downloadUnavailable'),
    nativeToolBusy: t('download.nativeTools.busy'),
  };
  return failure(code, messages[code] ?? t('download.nativeTools.failed'));
};

const statusById = (status) => new Map(status.tools.map((tool) => [tool.id, tool]));
const catalogById = (catalog) => new Map(catalog.tools.map((tool) => [tool.id, tool]));

const terminalInstall = ({
  tool,
  controller,
  install,
  report,
  onJobStarted,
  timeoutMs,
}) => new Promise((resolve, reject) => {
  let settled = false;
  const watchdog = setTimeout(() => {
    settle(reject, failure(
      'nativeToolInstallTimedOut',
      'The native tool operation did not return a terminal event'
    ));
    controller.abort();
  }, timeoutMs);
  const settle = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    callback(value);
  };
  const handlers = {
    onProgress: (event) => {
      report(tool, Math.floor(event.operation.basisPoints / 100));
    },
    onCompleted: (event) => {
      if (event.restartRequired || event.deferred || event.action !== 'install') {
        settle(reject, failure(
          'invalidNativeToolResponse',
          'The desktop host returned invalid native tool data'
        ));
        return;
      }
      report(tool, 100);
      settle(resolve, event);
    },
    onCancelled: () => settle(reject, failure(
      'nativeToolCancelled',
      'The native tool operation was cancelled'
    )),
    onFailed: (event) => settle(reject, failure(
      event.error.code,
      'The native tool operation failed'
    )),
    onProtocolError: () => settle(reject, failure(
      'invalidNativeToolResponse',
      'The desktop host returned invalid native tool data'
    )),
  };

  Promise.resolve(install(tool.id, handlers, { signal: controller.signal }))
    .then((job) => safeCall(onJobStarted, job))
    .catch((error) => settle(reject, error));
});

export const createNativeDownloadPreflight = ({
  readCatalog = getNativeToolsCatalog,
  readStatus = getNativeToolsStatus,
  install = installNativeTool,
  presentation = defaultPresentation,
  t = i18n.t.bind(i18n),
  installTimeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
} = {}) => {
  let active = null;

  const notify = (message, type, duration, button, key = TOOL_PROGRESS_TOAST_KEY) => safeCall(presentation.notify, {
    message,
    type,
    duration,
    key,
    button,
  });
  const dismiss = (key = TOOL_PROGRESS_TOAST_KEY) => safeCall(presentation.dismiss, key);
  const rejectWithNotice = (code, type = 'error') => {
    const error = localizedFailure(code, t);
    dismiss();
    notify(error.message, type, type === 'warning' ? 30_000 : 12_000);
    throw error;
  };

  const perform = async (options, controller, requiredIds) => {
    const abort = () => controller.abort();
    const operationToastKeys = new Set();
    const dismissOperationToasts = () => {
      operationToastKeys.forEach((key) => dismiss(key));
      operationToastKeys.clear();
    };
    if (options.signal?.aborted) throw localizedFailure('nativeToolCancelled', t);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const [catalog, status] = await Promise.all([readCatalog(), readStatus()]);
      const statuses = statusById(status);
      const catalogEntries = catalogById(catalog);
      const required = requiredIds.map((id) => ({
        ...catalogEntries.get(id),
        status: statuses.get(id),
      }));

      if (required.some((tool) => tool.status?.operation !== null)) {
        return rejectWithNotice('nativeToolBusy', 'warning');
      }
      if (required.some((tool) => tool.status?.state === 'corrupt')) {
        return rejectWithNotice('nativeToolCorrupt');
      }
      if (required.some((tool) => !tool.status?.deliveryAvailable)) {
        return rejectWithNotice('nativeToolUnavailable');
      }

      const installTargets = required.filter((tool) => tool.status.state === 'missing'
        || (tool.status.state === 'installed'
          && !tool.status.pendingRemoval
          && (!tool.status.activeRuntime || tool.status.restartRequired)));
      if (installTargets.length === 0) {
        if (required.every((tool) => tool.status.state === 'installed'
          && tool.status.activeRuntime
          && !tool.status.restartRequired)) {
          dismiss();
          return Object.freeze({ ready: true });
        }
        return rejectWithNotice('nativeToolHealthFailed');
      }

      const cancelButton = Object.freeze({
        text: t('download.nativeTools.cancel'),
        onClick: abort,
      });
      let lastReported = -PROGRESS_STEP_PERCENT;
      const lastToolReported = new Map();
      const toolProgress = new Map(installTargets.map((tool) => [tool.id, 0]));
      const report = (tool, percent) => {
        const bounded = Math.max(0, Math.min(100, percent));
        toolProgress.set(tool.id, Math.max(toolProgress.get(tool.id) ?? 0, bounded));
        const toolPercent = Math.floor(toolProgress.get(tool.id));
        const previousToolPercent = lastToolReported.get(tool.id) ?? -PROGRESS_STEP_PERCENT;
        if (toolPercent === 100 || toolPercent >= previousToolPercent + PROGRESS_STEP_PERCENT) {
          lastToolReported.set(tool.id, toolPercent);
          const key = toolProgressToastKey(tool.id);
          operationToastKeys.add(key);
          notify(t('download.nativeTools.installing', {
            tool: tool.label,
            percent: toolPercent,
          }), 'info', 120_000, cancelButton, key);
        }
        const aggregate = Math.floor(
          [...toolProgress.values()].reduce((total, value) => total + value, 0)
            / toolProgress.size
        );
        if (aggregate !== 100 && aggregate < lastReported + PROGRESS_STEP_PERCENT) return;
        lastReported = aggregate;
        safeCall(options.onProgress, aggregate);
      };

      installTargets.forEach((tool) => report(tool, 0));
      await Promise.all(installTargets.map(async (tool) => {
        if (controller.signal.aborted) throw localizedFailure('nativeToolCancelled', t);
        await terminalInstall({
          tool,
          controller,
          install,
          report,
          onJobStarted: options.onJobStarted,
          timeoutMs: installTimeoutMs,
        });
        dismiss(toolProgressToastKey(tool.id));
        operationToastKeys.delete(toolProgressToastKey(tool.id));
      }));
      const refreshed = statusById(await readStatus());
      if (requiredIds.some((id) => {
        const tool = refreshed.get(id);
        return tool?.state !== 'installed'
          || tool.activeRuntime !== true
          || tool.restartRequired !== false;
      })) {
        dismissOperationToasts();
        return rejectWithNotice('nativeToolHealthFailed');
      }
      dismissOperationToasts();
      dismiss();
      return Object.freeze({ ready: true });
    } catch (error) {
      if (error instanceof NativeDownloadPreflightError
          && error.message === localizedFailure(error.code, t).message) {
        throw error;
      }
      const code = error?.code === 'nativeToolInstallTimedOut'
        ? 'nativeToolInstallFailed'
        : controller.signal.aborted || error?.code === 'nativeToolCancelled'
          ? 'nativeToolCancelled'
          : error?.code === 'nativeToolBusy'
            ? 'nativeToolBusy'
            : 'nativeToolInstallFailed';
      controller.abort();
      dismissOperationToasts();
      dismiss();
      const normalized = localizedFailure(code, t);
      notify(normalized.message, code === 'nativeToolCancelled' ? 'warning' : 'error', 12_000);
      throw normalized;
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  };

  const ensureRequiredTools = (requiredIds, options) => {
    if (active === null) {
      const controller = new AbortController();
      const promise = perform(options, controller, requiredIds).finally(() => {
        if (active?.promise === promise) active = null;
      });
      active = Object.freeze({ controller, promise });
    }
    return active.promise;
  };

  const ensureInspectionReady = async (readiness, rawOptions) => {
    const options = validateOptions(rawOptions);
    if (readiness?.inspectAvailable === true) return Object.freeze({ ready: true });
    return ensureRequiredTools(MANAGED_DOWNLOAD_TOOL_IDS, options);
  };

  const ensureDownloadReady = async (readiness, rawOptions) => {
    const options = validateOptions(rawOptions);
    if (readiness?.available === true) return Object.freeze({ ready: true });
    if (readiness?.inspectAvailable !== true) {
      return ensureInspectionReady(readiness, rawOptions);
    }
    if (readiness?.reason === 'mediaToolsUnavailable') {
      return ensureRequiredTools(['media-tools'], options);
    }
    return rejectWithNotice('nativeDownloadUnavailable');
  };

  return Object.freeze({
    ensureInspectionReady,
    ensureDownloadReady,
    cancelActive: () => {
      if (active === null) return false;
      active.controller.abort();
      return true;
    },
  });
};

const nativeDownloadPreflight = createNativeDownloadPreflight();

let automaticRecovery = null;
let lastAutomaticRecovery = Number.NEGATIVE_INFINITY;

export const recoverNativeDownloaderAfterFailure = async ({
  readCatalog = getNativeToolsCatalog,
  readStatus = getNativeToolsStatus,
  install = installNativeTool,
  presentation = defaultPresentation,
  t = i18n.t.bind(i18n),
  now = Date.now,
  installTimeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
} = {}) => {
  if (automaticRecovery !== null) return automaticRecovery;
  const startedAt = now();
  if (!Number.isFinite(startedAt)
      || startedAt - lastAutomaticRecovery < AUTO_UPDATE_COOLDOWN_MS) {
    return Object.freeze({ updated: false, throttled: true });
  }
  lastAutomaticRecovery = startedAt;
  const controller = new AbortController();
  const run = (async () => {
    const [catalog, status] = await Promise.all([readCatalog(), readStatus()]);
    const tool = catalog.tools.find((entry) => entry.id === 'yt-dlp');
    const installed = status.tools.find((entry) => entry.id === 'yt-dlp');
    if (!tool
        || installed?.installed !== true
        || installed.activeRuntime !== true
        || installed.pendingRemoval
        || installed.operation !== null) {
      return Object.freeze({ updated: false, throttled: false });
    }
    const notify = (message, type, duration, button) => safeCall(presentation.notify, {
      message,
      type,
      duration,
      key: TOOL_PROGRESS_TOAST_KEY,
      button,
    });
    const dismiss = () => safeCall(presentation.dismiss, TOOL_PROGRESS_TOAST_KEY);
    const cancelButton = Object.freeze({
      text: t('download.nativeTools.cancel'),
      onClick: () => controller.abort(),
    });
    let lastPercent = -PROGRESS_STEP_PERCENT;
    const event = await new Promise((resolve, reject) => {
      let settled = false;
      const watchdog = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        reject(failure('nativeToolInstallTimedOut', 'The native tool update timed out'));
      }, installTimeoutMs);
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        callback(value);
      };
      const handlers = {
        onProgress: ({ operation }) => {
          const percent = Math.floor(operation.basisPoints / 100);
          if (percent !== 100 && percent < lastPercent + PROGRESS_STEP_PERCENT) return;
          lastPercent = percent;
          notify(t('download.nativeTools.installing', {
            tool: tool.label,
            percent,
          }), 'info', 120_000, cancelButton);
        },
        onCompleted: (completed) => settle(resolve, completed),
        onCancelled: () => settle(reject, localizedFailure('nativeToolCancelled', t)),
        onFailed: (failed) => settle(reject, failure(
          failed.error.code,
          t('download.nativeTools.failed')
        )),
        onProtocolError: () => settle(reject, failure(
          'invalidNativeToolResponse',
          'The desktop host returned invalid native tool data'
        )),
      };
      Promise.resolve(install('yt-dlp', handlers, { signal: controller.signal }))
        .catch((error) => settle(reject, error));
    });
    dismiss();
    if (event.restartRequired || event.deferred) {
      throw failure('nativeToolHealthFailed', t('download.nativeTools.healthFailed'));
    }
    return Object.freeze({ updated: true, throttled: false });
  })().catch((error) => {
    safeCall(presentation.dismiss, TOOL_PROGRESS_TOAST_KEY);
    return Object.freeze({ updated: false, throttled: false, error: error?.code ?? 'failed' });
  }).finally(() => {
    if (automaticRecovery === run) automaticRecovery = null;
  });
  automaticRecovery = run;
  return run;
};

export const resetNativeDownloaderRecoveryForTest = () => {
  automaticRecovery = null;
  lastAutomaticRecovery = Number.NEGATIVE_INFINITY;
};

export const ensureNativeDownloadInspectionReady = (
  readiness,
  options
) => nativeDownloadPreflight.ensureInspectionReady(readiness, options);

export const ensureNativeDownloadReady = (
  readiness,
  options
) => nativeDownloadPreflight.ensureDownloadReady(readiness, options);
