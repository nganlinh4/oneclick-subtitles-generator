import { validate as validateUuid, version as uuidVersion } from 'uuid';

import i18n from '../i18n/i18n';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

const MAX_IMPORT_ITEMS = 20_000;
const MAX_IMPORT_HISTORY = 64;
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,127}$/;
const SUMMARY_KEYS = Object.freeze([
  'sourceId',
  'state',
  'settings',
  'credentials',
  'artifacts',
  'ignored',
]);
const COUNT_KEYS = Object.freeze(['pending', 'imported', 'skipped', 'failed']);
const REPORT_KEYS = Object.freeze(['summary', 'sourceRetained', 'alreadyImported']);
const IMPORT_STATES = new Set(['running', 'complete', 'failed']);
const TOAST_KEY = 'legacy-data-import';
const INSTALLATION_KEY = Symbol.for('osg.legacyImportKeyboardAction.v1');
const INSTALLATION_OWNER = Symbol('osg.legacyImportKeyboardAction.owner');

const isPlainRecord = (value) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

const hasExactKeys = (value, expectedKeys) => {
  if (!isPlainRecord(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expectedKeys.length
      && keys.every((key) => {
        if (typeof key !== 'string' || !expectedKeys.includes(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
      });
  } catch {
    return false;
  }
};

const isSafeCount = (value) => (
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_IMPORT_ITEMS
);

export class LegacyImportServiceError extends Error {
  constructor(code, message = 'The legacy data import could not be completed') {
    super(message);
    this.name = 'LegacyImportServiceError';
    this.code = code;
  }
}

const invalidResponse = () => new LegacyImportServiceError(
  'invalidLegacyImportResponse',
  'The desktop host returned invalid legacy import information'
);

const runtimeUnavailable = () => new LegacyImportServiceError(
  'desktopRuntimeUnavailable',
  'Legacy data import requires the desktop runtime'
);

const importBusy = () => new LegacyImportServiceError(
  'legacyImportBusy',
  'Another legacy data import is already running'
);

const normalizeFailure = (error) => {
  if (error instanceof LegacyImportServiceError) return error;
  const code = typeof error?.code === 'string' && ERROR_CODE_PATTERN.test(error.code)
    ? error.code
    : 'legacyImportCommandFailed';
  return new LegacyImportServiceError(code);
};

const requireDesktopRuntime = (nativeRuntime) => {
  let available = false;
  try {
    available = nativeRuntime() === true;
  } catch {
    // Runtime detection is untrusted at this boundary and must not leak its diagnostics.
  }
  if (!available) throw runtimeUnavailable();
};

const normalizeCounts = (value) => {
  if (!hasExactKeys(value, COUNT_KEYS) || !COUNT_KEYS.every((key) => isSafeCount(value[key]))) {
    throw invalidResponse();
  }
  return Object.freeze(Object.fromEntries(COUNT_KEYS.map((key) => [key, value[key]])));
};

const addSafe = (left, right) => {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total > MAX_IMPORT_ITEMS) throw invalidResponse();
  return total;
};

const normalizeSummary = (value, { allowRunning }) => {
  if (!hasExactKeys(value, SUMMARY_KEYS)
      || typeof value.sourceId !== 'string'
      || !validateUuid(value.sourceId)
      || uuidVersion(value.sourceId) !== 7
      || !IMPORT_STATES.has(value.state)
      || (!allowRunning && value.state === 'running')) {
    throw invalidResponse();
  }

  const settings = normalizeCounts(value.settings);
  const credentials = normalizeCounts(value.credentials);
  const artifacts = normalizeCounts(value.artifacts);
  const ignored = normalizeCounts(value.ignored);
  const groups = [settings, credentials, artifacts, ignored];
  const totalItems = groups.reduce(
    (total, counts) => COUNT_KEYS.reduce((subtotal, key) => addSafe(subtotal, counts[key]), total),
    0
  );
  if (totalItems > MAX_IMPORT_ITEMS) throw invalidResponse();
  if (value.state === 'complete'
      && groups.some((counts) => counts.pending !== 0 || counts.failed !== 0)) {
    throw invalidResponse();
  }

  return Object.freeze({
    sourceId: value.sourceId,
    state: value.state,
    settings,
    credentials,
    artifacts,
    ignored,
  });
};

export const normalizeLegacyImportReport = (value) => {
  if (!hasExactKeys(value, REPORT_KEYS)
      || value.sourceRetained !== true
      || typeof value.alreadyImported !== 'boolean') {
    throw invalidResponse();
  }
  const summary = normalizeSummary(value.summary, { allowRunning: false });
  if (value.alreadyImported && summary.state !== 'complete') throw invalidResponse();
  return Object.freeze({
    summary,
    sourceRetained: true,
    alreadyImported: value.alreadyImported,
  });
};

export const normalizeLegacyImportStatus = (value) => {
  if (!Array.isArray(value) || value.length > MAX_IMPORT_HISTORY) throw invalidResponse();
  const summaries = value.map((summary) => normalizeSummary(summary, { allowRunning: true }));
  const sourceIds = new Set(summaries.map((summary) => summary.sourceId));
  if (sourceIds.size !== summaries.length) throw invalidResponse();
  return Object.freeze(summaries);
};

export const createLegacyImportService = ({
  invokeCommand = invokeDesktop,
  nativeRuntime = isDesktopRuntime,
} = {}) => {
  let importInProgress = false;

  const importLegacyData = async () => {
    requireDesktopRuntime(nativeRuntime);
    if (importInProgress) throw importBusy();
    importInProgress = true;
    try {
      const report = await invokeCommand('legacy_import_select', {});
      return report === null ? null : normalizeLegacyImportReport(report);
    } catch (error) {
      throw normalizeFailure(error);
    } finally {
      importInProgress = false;
    }
  };

  const getLegacyImportStatus = async () => {
    requireDesktopRuntime(nativeRuntime);
    try {
      return normalizeLegacyImportStatus(await invokeCommand('legacy_import_status', {}));
    } catch (error) {
      throw normalizeFailure(error);
    }
  };

  return Object.freeze({
    importLegacyData,
    getLegacyImportStatus,
    isImportInProgress: () => importInProgress,
  });
};

const legacyImportService = createLegacyImportService();

export const importLegacyData = legacyImportService.importLegacyData;
export const getLegacyImportStatus = legacyImportService.getLegacyImportStatus;

const summaryTotals = (summary) => {
  const groups = [summary.settings, summary.credentials, summary.artifacts, summary.ignored];
  return Object.freeze(Object.fromEntries(COUNT_KEYS.map((key) => [
    key,
    groups.reduce((total, counts) => total + counts[key], 0),
  ])));
};

const defaultNotify = (message, type, duration) => {
  if (typeof window !== 'undefined' && typeof window.addToast === 'function') {
    window.addToast(message, type, duration, TOAST_KEY);
  }
};

const notifySafely = (notify, message, type, duration) => {
  try {
    notify(message, type, duration);
  } catch {
    // Toast failures must never change import state or cause a duplicate native invocation.
  }
};

const importErrorMessage = (code, t) => {
  switch (code) {
    case 'legacyImportBusy':
      return t('common.legacyImport.busy');
    case 'invalidLegacyImport':
      return t('common.legacyImport.invalid');
    case 'legacyImportTooLarge':
      return t('common.legacyImport.tooLarge');
    default:
      return t('common.legacyImport.failed');
  }
};

const isMacPlatform = (platform) => /^mac/i.test(platform.trim());

const currentPlatform = () => {
  if (typeof navigator === 'undefined') return '';
  return navigator.userAgentData?.platform || navigator.platform || '';
};

const isLegacyImportShortcut = (event, macPlatform) => (
  event.code === 'KeyI'
  && event.altKey
  && event.shiftKey
  && (macPlatform
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey)
  && !event.repeat
  && !event.isComposing
);

/**
 * Install the non-visual desktop migration action.
 *
 * Windows/Linux: Ctrl+Alt+Shift+I. macOS: Command+Option+Shift+I. The native command owns the
 * folder picker; the WebView never receives a selected path.
 */
export const installLegacyImportKeyboardAction = ({
  nativeRuntime = isDesktopRuntime,
  service = legacyImportService,
  eventTarget = typeof document === 'undefined' ? null : document,
  notify = defaultNotify,
  platform = currentPlatform(),
  t = i18n.t.bind(i18n),
} = {}) => {
  try {
    if (!nativeRuntime()
        || !eventTarget
        || typeof eventTarget.addEventListener !== 'function'
        || typeof eventTarget.removeEventListener !== 'function'
        || typeof service?.importLegacyData !== 'function'
        || typeof notify !== 'function'
        || typeof t !== 'function'
        || typeof platform !== 'string') {
      return () => {};
    }
  } catch {
    return () => {};
  }

  const existing = globalThis[INSTALLATION_KEY];
  if (existing?.owner === INSTALLATION_OWNER && existing.eventTarget === eventTarget) {
    return existing.cleanup;
  }
  if (typeof existing?.cleanup === 'function') {
    try {
      existing.cleanup();
    } catch {
      // Never stack a second global shortcut when a stale installation cannot be removed safely.
      return () => {};
    }
  }

  const macPlatform = isMacPlatform(platform);

  const handleKeyDown = (event) => {
    if (event.defaultPrevented || !isLegacyImportShortcut(event, macPlatform)) return;
    event.preventDefault();
    notifySafely(
      notify,
      t('common.legacyImport.selectFolder'),
      'info',
      120_000
    );
    void service.importLegacyData().then((report) => {
      if (report === null) {
        notifySafely(notify, t('common.legacyImport.cancelled'), 'info', 4_000);
        return;
      }
      if (report.alreadyImported) {
        notifySafely(
          notify,
          t('common.legacyImport.alreadyImported'),
          'info',
          8_000
        );
        return;
      }
      const totals = summaryTotals(report.summary);
      if (report.summary.state === 'failed') {
        notifySafely(
          notify,
          t('common.legacyImport.failedItems', { count: totals.failed }),
          'warning',
          12_000
        );
        return;
      }
      notifySafely(
        notify,
        t('common.legacyImport.complete', {
          imported: totals.imported,
          skipped: totals.skipped,
        }),
        'success',
        12_000
      );
    }).catch((error) => {
      notifySafely(notify, importErrorMessage(error?.code, t), 'error', 10_000);
    });
  };

  eventTarget.addEventListener('keydown', handleKeyDown);
  let installed = true;
  const cleanup = () => {
    if (!installed) return;
    installed = false;
    eventTarget.removeEventListener('keydown', handleKeyDown);
    if (globalThis[INSTALLATION_KEY]?.cleanup === cleanup) {
      delete globalThis[INSTALLATION_KEY];
    }
  };
  globalThis[INSTALLATION_KEY] = Object.freeze({
    owner: INSTALLATION_OWNER,
    eventTarget,
    cleanup,
  });
  return cleanup;
};
