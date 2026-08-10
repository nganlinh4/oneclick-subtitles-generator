import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cancelNativeToolJob,
  getNativeToolsCatalog,
  getNativeToolsStatus,
  installNativeTool,
  removeNativeTool,
} from '../../platform/nativeToolsService';
import {
  cancelRenderPackageJob,
  getRenderPackageStatus,
  installRenderPackage,
  removeRenderPackage,
} from '../../platform/renderPackageService';

const TOOL_META = Object.freeze({
  'media-tools': Object.freeze({ kind: 'media', source: 'vendor' }),
  'yt-dlp': Object.freeze({ kind: 'downloader', source: 'official' }),
  deno: Object.freeze({ kind: 'javascript', source: 'official' }),
  'remotion-runtime': Object.freeze({ kind: 'renderer', source: 'pool' }),
});

const RENDER_CATALOG = Object.freeze({
  id: 'remotion-runtime',
  label: 'Remotion video renderer',
  license: 'Remotion License + bundled third-party notices',
});

const formatBytes = (bytes) => {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
};

export const NativeToolRow = ({ catalog, status, onChanged }) => {
  const { t } = useTranslation();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState(null);
  const [localOperation, setLocalOperation] = useState(null);
  const operation = localOperation || status.operation;
  const meta = TOOL_META[catalog.id];

  const refresh = useCallback(() => {
    setLocalOperation(null);
    onChanged();
  }, [onChanged]);

  const run = useCallback((action) => {
    setConfirmRemove(false);
    setError(null);
    const isRenderer = catalog.id === 'remotion-runtime';
    const command = isRenderer
      ? action === 'remove' ? removeRenderPackage : installRenderPackage
      : action === 'remove' ? removeNativeTool : installNativeTool;
    const handlers = {
      onProgress: ({ operation: next }) => setLocalOperation(next),
      onCompleted: refresh,
      onCancelled: refresh,
      onFailed: (event) => {
        setError(event.error.message);
        refresh();
      },
      onProtocolError: () => {
        setError(t('engines.error.nativeToolProtocol', 'The desktop host returned invalid tool progress.'));
        refresh();
      },
    };
    const request = isRenderer ? command(handlers) : command(catalog.id, handlers);
    request.catch(() => {
      setError(t('engines.error.nativeToolFailed', 'The tool operation could not start.'));
      refresh();
    });
  }, [catalog.id, refresh, t]);

  const state = operation
    ? operation.action === 'remove' ? 'removing' : 'installing'
    : status.pendingRemoval
      ? 'pending-removal'
      : status.state === 'installed' && status.restartRequired
        ? 'restart-required'
        : status.state;
  const version = status.version || status.availableVersion;
  const installedSize = formatBytes(status.installedBytes);
  const downloadSize = formatBytes(status.downloadBytes);
  const availableInstalledSize = formatBytes(status.availableInstalledBytes);
  const capacityMeta = status.installed
    ? installedSize ? [t('engines.diskSize', '{{size}} disk', { size: installedSize })] : []
    : [
      downloadSize ? t('engines.downloadSize', '{{size}} download', { size: downloadSize }) : null,
      availableInstalledSize
        ? t('engines.diskSize', '{{size}} disk', { size: availableInstalledSize })
        : null,
    ].filter(Boolean);
  const details = [
    t(`engines.nativeKind.${meta.kind}`),
    t(`engines.nativeSource.${meta.source}`),
    catalog.license,
    version ? `v${version}` : null,
  ].filter(Boolean).join(' · ');
  const stateDetails = [
    operation ? t(`engines.phase.${operation.phase}`, operation.phase) : t(`engines.nativeState.${state}`, state),
    operation && operation.totalBytes > 0
      ? t('engines.progressBytes', '{{done}} / {{total}}', {
        done: formatBytes(operation.bytesDone) || '0 B',
        total: formatBytes(operation.totalBytes) || '0 B',
      })
      : null,
    ...(!operation ? capacityMeta : []),
  ].filter(Boolean).join(' · ');

  const renderAction = () => {
    if (operation) {
      return (
        <div className="engine-card__installing">
          <span className="tools-ledger__percent">{Math.floor(operation.basisPoints / 100)}%</span>
          <button
            type="button"
            className="engine-card__cancel"
            onClick={() => (
              catalog.id === 'remotion-runtime'
                ? cancelRenderPackageJob(operation.job.id)
                : cancelNativeToolJob(operation.job.id)
            ).catch(() => {})}
            title={t('engines.cancel', 'Cancel')}
            aria-label={t('engines.cancel', 'Cancel')}
          >
            <span className="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </div>
      );
    }
    if (status.pendingRemoval) {
      return <span className="engine-card__unavailable">{t('engines.restartToRemove', 'Restart to remove')}</span>;
    }
    if (confirmRemove) {
      return (
        <div className="engine-card__confirm">
          <span className="engine-card__confirm-text">{t('engines.confirmUninstall', 'Uninstall?')}</span>
          <button type="button" className="engine-card__icon-btn engine-card__icon-btn--danger" onClick={() => run('remove')} aria-label={t('engines.uninstall', 'Uninstall')}>
            <span className="material-symbols-rounded" aria-hidden="true">check</span>
          </button>
          <button type="button" className="engine-card__icon-btn" onClick={() => setConfirmRemove(false)} aria-label={t('engines.cancel', 'Cancel')}>
            <span className="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </div>
      );
    }
    if (status.state === 'unavailable') {
      return <span className="engine-card__unavailable">{t('engines.notPublished', 'Not published')}</span>;
    }
    if (status.state === 'missing' || status.state === 'corrupt') {
      return (
        <button type="button" className="engine-card__btn" onClick={() => run('install')}>
          <span className="material-symbols-rounded" aria-hidden="true">{status.state === 'corrupt' ? 'build' : 'download'}</span>
          {status.state === 'corrupt' ? t('engines.repair', 'Repair') : t('engines.download', 'Download')}
        </button>
      );
    }
    return (
      <button type="button" className="engine-card__icon-btn" onClick={() => setConfirmRemove(true)} title={t('engines.uninstall', 'Uninstall')} aria-label={t('engines.uninstall', 'Uninstall')}>
        <span className="material-symbols-rounded" aria-hidden="true">delete</span>
      </button>
    );
  };

  return (
    <div className={`engine-card engine-card--${state}`}>
      <div className="engine-card__row">
        <span className="material-symbols-rounded engine-card__icon" aria-hidden="true">
          {status.state === 'installed' ? 'check_circle' : status.state === 'corrupt' ? 'warning' : 'download'}
        </span>
        <div className="engine-card__info">
          <span className="engine-card__label">{catalog.label}</span>
          <span className="engine-card__sub">{details}</span>
          <span className="engine-card__state-line">{stateDetails}</span>
        </div>
        <div className="engine-card__action">{renderAction()}</div>
      </div>
      {error && <div className="engine-card__error">{error}</div>}
    </div>
  );
};

const NativeToolsList = () => {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState([]);
  const [status, setStatus] = useState(new Map());
  const [loadState, setLoadState] = useState('checking');

  const refresh = useCallback(async () => {
    setLoadState('checking');
    try {
      const [catalogResponse, statusResponse, renderStatus] = await Promise.all([
        getNativeToolsCatalog(),
        getNativeToolsStatus(),
        getRenderPackageStatus(),
      ]);
      setCatalog([...catalogResponse.tools, RENDER_CATALOG]);
      setStatus(new Map([
        ...statusResponse.tools.map((tool) => [tool.id, tool]),
        [renderStatus.id, {
          ...renderStatus,
          activeRuntime: renderStatus.installed,
          pendingRemoval: false,
          restartRequired: false,
        }],
      ]));
      setLoadState('ready');
    } catch {
      setLoadState('failed');
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
    const refreshOnFocus = () => refresh().catch(() => {});
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [refresh]);

  const installed = useMemo(
    () => [...status.values()].filter((tool) => tool.installed).length,
    [status]
  );
  const hasOperation = useMemo(
    () => [...status.values()].some((tool) => tool.operation !== null),
    [status]
  );

  useEffect(() => {
    if (!hasOperation) return undefined;
    const timer = setInterval(() => refresh().catch(() => {}), 1500);
    return () => clearInterval(timer);
  }, [hasOperation, refresh]);

  return (
    <section className="tools-ledger__group" aria-labelledby="runtime-tools-heading">
      <div className="tools-ledger__heading">
        <div>
          <h3 id="runtime-tools-heading">{t('engines.groups.runtime', 'Runtime tools')}</h3>
          <span>{t('engines.groups.runtimeDetail', 'Downloaded outside the app')}</span>
        </div>
        <span className="tools-ledger__count">
          {t('engines.installedCount', '{{installed}} installed', { installed })}
        </span>
      </div>
      <div className="engines-panel__grid engines-panel__grid--runtime">
        {loadState === 'checking' && catalog.length === 0 && (
          <div className="tools-ledger__status" role="status">
            <span className="material-symbols-rounded tools-ledger__status-icon" aria-hidden="true">progress_activity</span>
            <span>{t('engines.checking', 'Checking…')}</span>
          </div>
        )}
        {loadState === 'failed' && (
          <div className="tools-ledger__status tools-ledger__status--error" role="alert">
            <span>{t('engines.statusUnavailable', 'The desktop runtime did not return tool status.')}</span>
            <button type="button" className="engine-card__btn engine-card__btn--ghost" onClick={() => refresh()}>
              <span className="material-symbols-rounded" aria-hidden="true">refresh</span>
              {t('engines.retryStatus', 'Retry')}
            </button>
          </div>
        )}
        {loadState !== 'failed' && catalog.map((tool) => status.has(tool.id) && (
          <NativeToolRow
            key={tool.id}
            catalog={tool}
            status={status.get(tool.id)}
            onChanged={() => refresh().catch(() => {})}
          />
        ))}
      </div>
    </section>
  );
};

export default NativeToolsList;
