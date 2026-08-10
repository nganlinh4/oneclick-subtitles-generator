import {
  cancelDownload,
  inspectDownloadUrl,
  startDownload,
} from './downloadService';
import { openMediaAsset } from './mediaService';

const DEFAULT_MEDIA_SELECTION = Object.freeze({
  kind: 'video',
  quality: Object.freeze({ mode: 'best' }),
});
const MAX_PREFERRED_SUBTITLE_LANGUAGES = 32;

const safeCall = (callback, value) => {
  if (typeof callback !== 'function') return;
  try {
    callback(value);
  } catch {
    // A presentation callback cannot break the native download lifecycle.
  }
};

const progressPercent = (event) => {
  const fraction = event.progress.fraction;
  const basisPoints = event.job.progress.basisPoints;
  const percent = fraction === null
    ? Math.round(basisPoints / 100)
    : Math.round(fraction * 100);
  return Math.max(0, Math.min(100, percent));
};

const fixedFailure = (code = 'nativeDownloadFailed') => {
  const error = new Error('The native media download could not be completed');
  error.name = 'NativeUrlDownloadError';
  error.code = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(code)
    ? code
    : 'nativeDownloadFailed';
  return error;
};

const normalizePreferredLanguages = (languages) => {
  if (languages === undefined) return Object.freeze([]);
  if (!Array.isArray(languages) || languages.length > MAX_PREFERRED_SUBTITLE_LANGUAGES) {
    throw fixedFailure('invalidDownloadRequest');
  }
  const normalized = languages.map((language) => {
    if (typeof language !== 'string' || !/^[A-Za-z0-9._-]{1,35}$/.test(language)) {
      throw fixedFailure('invalidDownloadRequest');
    }
    return language.toLowerCase();
  });
  return Object.freeze([...new Set(normalized)]);
};

const selectSubtitle = (inventory, preferredLanguages) => {
  if (preferredLanguages.length === 0 || !Array.isArray(inventory?.subtitles)) return null;
  for (const preferred of preferredLanguages) {
    const preferredBase = preferred.split('-')[0];
    const candidates = inventory.subtitles.filter(({ language }) => {
      const normalized = language.toLowerCase();
      return normalized === preferred
        || normalized.split('-')[0] === preferredBase;
    });
    candidates.sort((left, right) => {
      if (left.source === right.source) return 0;
      return left.source === 'manual' ? -1 : 1;
    });
    if (candidates[0]) {
      return Object.freeze({
        language: candidates[0].language,
        source: candidates[0].source,
      });
    }
  }
  return null;
};

const operationKey = (url, cookieSource, preferredLanguages) => (
  `${cookieSource}\u0000${preferredLanguages.join(',')}\u0000${url}`
);

export const createNativeUrlDownloadAdapter = ({
  inspect = inspectDownloadUrl,
  start = startDownload,
  cancel = cancelDownload,
  openAsset = openMediaAsset,
} = {}) => {
  const active = new Map();
  const completedAssets = new Map();

  const subscribe = (operation, { onStarted, onProgress, onSubtitle }) => {
    const listener = { onStarted, onProgress, onSubtitle };
    operation.listeners.add(listener);
    if (operation.jobId !== null) safeCall(onStarted, operation.jobId);
    if (operation.percent !== null) safeCall(onProgress, operation.percent);
    if (operation.subtitle !== null) safeCall(onSubtitle, operation.subtitle);
    return operation.promise.finally(() => operation.listeners.delete(listener));
  };

  const createOperation = (key, url, cookieSource, preferredLanguages) => {
    const operation = {
      jobId: null,
      listeners: new Set(),
      percent: null,
      promise: null,
      subtitle: null,
    };

    operation.promise = (async () => {
      const inspection = await inspect({ url, cookieSource });
      const subtitle = selectSubtitle(inspection.inventory, preferredLanguages);
      let resolveTerminal;
      let terminal = null;
      const terminalPromise = new Promise((resolve) => { resolveTerminal = resolve; });
      const settle = (outcome) => {
        if (terminal !== null) return;
        terminal = outcome;
        resolveTerminal(outcome);
      };

      let initial;
      try {
        initial = await start({
          inventoryId: inspection.capability.id,
          media: DEFAULT_MEDIA_SELECTION,
          subtitle,
        }, {
          onProgress: (event) => {
            const next = progressPercent(event);
            operation.percent = operation.percent === null
              ? next
              : Math.max(operation.percent, next);
            operation.listeners.forEach((listener) => safeCall(
              listener.onProgress,
              operation.percent
            ));
          },
          onCompleted: (event) => {
            operation.subtitle = event.subtitle ?? null;
            if (operation.subtitle !== null) {
              operation.listeners.forEach((listener) => safeCall(
                listener.onSubtitle,
                operation.subtitle
              ));
            }
            openAsset(event.media.asset.id)
              .then((media) => settle({
                kind: 'completed',
                media,
                assetId: event.media.asset.id,
                subtitle: operation.subtitle,
              }))
              .catch(() => settle({ kind: 'failed', error: fixedFailure('mediaOpenFailed') }));
          },
          onCancelled: () => settle({ kind: 'cancelled' }),
          onFailed: (event) => settle({
            kind: 'failed',
            error: fixedFailure(event.error.code),
          }),
          onProtocolError: () => settle({
            kind: 'protocolError',
            error: fixedFailure('invalidDownloadResponse'),
          }),
        });
      } catch (error) {
        throw fixedFailure(error?.code);
      }

      operation.jobId = initial.id;
      operation.listeners.forEach((listener) => safeCall(listener.onStarted, initial.id));

      const outcome = await terminalPromise;
      if (outcome.kind === 'protocolError') {
        await cancel(initial.id).catch(() => undefined);
      }
      if (outcome.kind === 'completed') {
        completedAssets.set(key, Object.freeze({
          assetId: outcome.assetId,
          subtitle: outcome.subtitle,
        }));
        return outcome.media;
      }
      if (outcome.kind === 'cancelled') return null;
      throw outcome.error;
    })().finally(() => active.delete(key));

    active.set(key, operation);
    return operation;
  };

  const downloadVideo = async ({
    url,
    useCookies = false,
    onStarted,
    onProgress,
    onSubtitle,
    preferredSubtitleLanguages,
  }) => {
    const cookieSource = useCookies ? 'chrome' : 'none';
    const preferredLanguages = normalizePreferredLanguages(preferredSubtitleLanguages);
    const key = operationKey(url, cookieSource, preferredLanguages);
    const completed = completedAssets.get(key);
    if (completed) {
      try {
        const media = await openAsset(completed.assetId);
        safeCall(onProgress, 100);
        if (completed.subtitle !== null) safeCall(onSubtitle, completed.subtitle);
        return media;
      } catch {
        completedAssets.delete(key);
      }
    }

    const operation = active.get(key)
      ?? createOperation(key, url, cookieSource, preferredLanguages);
    return subscribe(operation, { onStarted, onProgress, onSubtitle });
  };

  return Object.freeze({ downloadVideo });
};

const nativeUrlDownloadAdapter = createNativeUrlDownloadAdapter();

export const downloadNativeVideo = nativeUrlDownloadAdapter.downloadVideo;
