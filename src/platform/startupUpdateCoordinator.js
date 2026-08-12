import i18n from '../i18n/i18n';
import { isDesktopRuntime } from './desktopRuntime';
import { checkDesktopUpdate, installDesktopUpdate } from './updateService';

const AVAILABLE_TOAST_KEY = 'app-update-available';
const INSTALL_TOAST_KEY = 'app-update-install';
const INSTALL_TOAST_DURATION = 30 * 60 * 1000;

let startupCheck = null;
let cachedStatus;
let startupCheckInFlight = false;
const statusListeners = new Set();

const addToast = (message, type, duration, key, button) => {
  if (typeof window !== 'undefined' && typeof window.addToast === 'function') {
    window.addToast(message, type, duration, key, button);
  }
};

const publishStatus = (status) => {
  cachedStatus = status;
  for (const listener of statusListeners) {
    try {
      listener(status);
    } catch {
      // A detached presentation surface cannot invalidate the shared native updater result.
    }
  }
};

export const offerDesktopUpdate = (update, {
  t = i18n.t.bind(i18n),
  install = installDesktopUpdate,
  showToast = addToast,
} = {}) => {
  const beginInstall = () => beginDesktopUpdateInstall(update, { t, install, showToast });

  showToast(
    t('settings.updateReady', 'OSG {{version}} is ready to install.', { version: update.version }),
    'info',
    60_000,
    AVAILABLE_TOAST_KEY,
    {
      text: t('settings.installUpdate', 'Install update'),
      onClick: beginInstall,
    },
  );
};

export const beginDesktopUpdateInstall = (update, {
  t = i18n.t.bind(i18n),
  install = installDesktopUpdate,
  showToast = addToast,
} = {}) => {
  const controller = new AbortController();
  const cancelButton = {
    text: t('common.cancel', 'Cancel'),
    onClick: () => controller.abort(),
  };
  showToast(
    t('settings.updatePreparing', 'Preparing the signed update…'),
    'info',
    INSTALL_TOAST_DURATION,
    INSTALL_TOAST_KEY,
    cancelButton,
  );
  install(update.version, {
    onProgress: ({ basisPoints }) => {
      const percent = basisPoints === null ? null : Math.floor(basisPoints / 100);
      showToast(
        percent === null
          ? t('settings.updateDownloading', 'Downloading the signed update…')
          : t('settings.updateDownloadingPercent', 'Downloading the signed update… {{percent}}%', { percent }),
        'info',
        INSTALL_TOAST_DURATION,
        INSTALL_TOAST_KEY,
        cancelButton,
      );
    },
    onInstalling: () => showToast(
      t('settings.updateInstalling', 'Update verified. Starting the installer…'),
      'info',
      INSTALL_TOAST_DURATION,
      INSTALL_TOAST_KEY,
      null,
    ),
  }, { signal: controller.signal }).catch((error) => {
    const cancelled = error?.code === 'updaterCancelled';
    showToast(
      cancelled
        ? t('settings.updateCancelled', 'Application update cancelled.')
        : t('settings.updateInstallFailed', 'The signed update could not be installed.'),
      cancelled ? 'info' : 'error',
      cancelled ? 6000 : 8000,
      INSTALL_TOAST_KEY,
      null,
    );
  });
  return controller;
};

export const startStartupUpdateCheck = ({
  nativeRuntime = isDesktopRuntime,
  check = checkDesktopUpdate,
  offer = offerDesktopUpdate,
} = {}) => {
  if (!nativeRuntime()) return Promise.resolve(null);
  if (startupCheck !== null) return startupCheck;
  startupCheckInFlight = true;
  startupCheck = check()
    .then((status) => {
      publishStatus(status);
      if (status.configured && status.update !== null) {
        try {
          offer(status.update);
        } catch {
          // The signed status remains authoritative even if the optional toast surface is absent.
        }
      }
      return status;
    })
    .catch(() => {
      publishStatus(null);
      return null;
    })
    .finally(() => {
      startupCheckInFlight = false;
    });
  return startupCheck;
};

export const getCachedDesktopUpdateStatus = () => cachedStatus;

export const subscribeDesktopUpdateStatus = (listener) => {
  if (typeof listener !== 'function') throw new TypeError('Update status listener must be a function');
  statusListeners.add(listener);
  if (cachedStatus !== undefined) {
    try {
      listener(cachedStatus);
    } catch {
      // Initial replay has the same isolation guarantee as later status publications.
    }
  }
  return () => statusListeners.delete(listener);
};

export const refreshDesktopUpdateCheck = ({
  nativeRuntime = isDesktopRuntime,
  check = checkDesktopUpdate,
  offer = offerDesktopUpdate,
} = {}) => {
  if (!nativeRuntime()) return Promise.resolve(null);
  if (startupCheckInFlight) return startupCheck;
  startupCheck = null;
  return startStartupUpdateCheck({ nativeRuntime, check, offer });
};

export const resetStartupUpdateCheckForTests = () => {
  startupCheck = null;
  cachedStatus = undefined;
  startupCheckInFlight = false;
  statusListeners.clear();
};
