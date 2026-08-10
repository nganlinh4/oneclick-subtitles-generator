import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import useEngineInstall from '../../hooks/useEngineInstall';
import LoadingIndicator from '../common/LoadingIndicator';
import WavyProgressIndicator from '../common/WavyProgressIndicator';
import { useWaveColors } from '../../utils/waveColors';

/**
 * One heavy engine row: a single centered line — [state icon] [name + descriptor·state] … [action].
 * The action reflects the state:
 *   - installing  → wavy progress bar (milestone %) + Cancel
 *   - starting / stopping / uninstalling → loading spinner + label (transient transitions)
 *   - confirm-uninstall → "Uninstall?" + confirm/cancel
 *   - installed-stopped → Start + trash · ready → Stop + trash · not-installed → Download
 * Uses the shared Material 3 WavyProgressIndicator + LoadingIndicator so it matches the rest of the
 * app's download/processing UI.
 */
const STATE_ICON = {
  ready: 'check_circle',
  included: 'inventory_2',
  'installed-stopped': 'pause_circle',
  'not-installed': 'download',
  'update-available': 'system_update_alt',
  unavailable: 'block',
  corrupt: 'warning',
  checking: 'progress_activity',
};

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

const EngineCard = ({
  id,
  name,
  kind,
  status,
  onChanged,
  managedByElectron = false,
  packageStatusState = 'ready',
}) => {
  const { t } = useTranslation();
  const packageStatus = status?.package;
  const { install, cancel, start, stop, uninstall, installing, percent, log, error } = useEngineInstall(
    id,
    { reconnect: Boolean(packageStatus?.operation), onStatusChanged: onChanged }
  );
  const packageOperation = packageStatus?.operation || null;
  const packageInstalling = packageOperation?.action === 'install'
    || packageOperation?.action === 'update';
  const packageRemoving = packageOperation?.action === 'remove';
  const isInstalling = installing || packageInstalling;
  const state = managedByElectron
    ? (status?.running ? 'ready' : 'included')
    : !packageStatus
      ? packageStatusState === 'failed' ? 'status-error' : 'checking'
      : packageStatus.state === 'unavailable'
        ? 'unavailable'
        : packageStatus.state === 'corrupt'
          ? 'corrupt'
          : packageStatus.state === 'update-available'
            ? 'update-available'
            : packageStatus.installed
              ? status?.running ? 'ready' : 'installed-stopped'
              : 'not-installed';
  const lastLog = log.length ? log[log.length - 1] : '';
  const { isDarkTheme, waveColor, waveTrackColor } = useWaveColors();

  // Transient transition flags (the underlying status poll catches up a beat later).
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const startTimer = useRef(null);

  useEffect(() => {
    if (status?.running) {
      setStarting(false);
      if (startTimer.current) { clearTimeout(startTimer.current); startTimer.current = null; }
    } else {
      setStopping(false);
    }
  }, [status?.running]);
  useEffect(() => () => { if (startTimer.current) clearTimeout(startTimer.current); }, []);

  const refreshSoon = (ms) => setTimeout(() => onChanged && onChanged(), ms);

  const handleStart = async () => {
    setStarting(true);
    if (startTimer.current) clearTimeout(startTimer.current);
    startTimer.current = setTimeout(() => setStarting(false), 120000);
    try { await start(); refreshSoon(800); } catch (_) { setStarting(false); }
  };

  const handleStop = async () => {
    setStopping(true);
    try { await stop(); refreshSoon(800); } catch (_) { setStopping(false); }
  };

  const handleUninstall = async () => {
    setConfirmUninstall(false);
    setUninstalling(true);
    try { await uninstall(); refreshSoon(500); } finally { setUninstalling(false); }
  };

  const loadingRow = (key, fallback) => (
    <div className="engine-card__loading">
      <LoadingIndicator theme={isDarkTheme ? 'light' : 'dark'} showContainer={false} size={18} color={waveColor} />
      <span className="engine-card__loading-text">{t(key, fallback)}</span>
    </div>
  );

  const trashButton = (
    <button
      type="button"
      className="engine-card__icon-btn"
      onClick={() => setConfirmUninstall(true)}
      title={t('engines.uninstall', 'Uninstall')}
      aria-label={t('engines.uninstall', 'Uninstall')}
    >
      <span className="material-symbols-rounded" aria-hidden="true">delete</span>
    </button>
  );

  const renderAction = () => {
    if (isInstalling) {
      return (
        <div className="engine-card__installing">
          <LoadingIndicator theme={isDarkTheme ? 'light' : 'dark'} showContainer={false} size={16} color={waveColor} />
          <div className="engine-card__wavy">
            <WavyProgressIndicator
              progress={Math.max(0, Math.min(1,
                packageOperation ? packageOperation.basisPoints / 10000 : (percent || 0) / 100
              ))}
              animate={true}
              showStopIndicator={true}
              waveSpeed={1.2}
              height={12}
              minWidth={48}
              color={waveColor}
              trackColor={waveTrackColor}
              stopIndicatorColor={waveColor}
            />
          </div>
          <button type="button" className="engine-card__cancel" onClick={() => cancel(packageOperation?.job?.id)} title={t('engines.cancel', 'Cancel')} aria-label={t('engines.cancel', 'Cancel')}>
            <span className="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </div>
      );
    }
    if (uninstalling || packageRemoving) {
      return (
        <div className="engine-card__installing">
          {loadingRow('engines.uninstalling', 'Uninstalling…')}
          <button type="button" className="engine-card__cancel" onClick={() => cancel(packageOperation?.job?.id)} title={t('engines.cancel', 'Cancel')} aria-label={t('engines.cancel', 'Cancel')}>
            <span className="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </div>
      );
    }
    if (managedByElectron) return <span className="engine-card__managed">{t('engines.included', 'Included')}</span>;
    if (state === 'checking') return loadingRow('engines.checking', 'Checking…');
    if (state === 'status-error') {
      return (
        <button type="button" className="engine-card__btn engine-card__btn--ghost" onClick={onChanged}>
          <span className="material-symbols-rounded" aria-hidden="true">refresh</span>
          {t('engines.retryStatus', 'Retry')}
        </button>
      );
    }
    if (state === 'unavailable') {
      return <span className="engine-card__unavailable">{t('engines.notPublished', 'Not published')}</span>;
    }
    if (confirmUninstall) {
      return (
        <div className="engine-card__confirm">
          <span className="engine-card__confirm-text">{t('engines.confirmUninstall', 'Uninstall?')}</span>
          <button type="button" className="engine-card__icon-btn engine-card__icon-btn--danger" onClick={handleUninstall} title={t('engines.uninstall', 'Uninstall')} aria-label={t('engines.uninstall', 'Uninstall')}>
            <span className="material-symbols-rounded" aria-hidden="true">check</span>
          </button>
          <button type="button" className="engine-card__icon-btn" onClick={() => setConfirmUninstall(false)} title={t('engines.cancel', 'Cancel')} aria-label={t('engines.cancel', 'Cancel')}>
            <span className="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </div>
      );
    }
    if (starting && state !== 'ready') return loadingRow('engines.starting', 'Starting…');
    if (stopping && state !== 'installed-stopped') return loadingRow('engines.stopping', 'Stopping…');
    if (state === 'installed-stopped') {
      return (
        <>
          <button type="button" className="engine-card__btn" onClick={handleStart}>
            <span className="material-symbols-rounded" aria-hidden="true">play_arrow</span>
            {t('engines.start', 'Start')}
          </button>
          {trashButton}
        </>
      );
    }
    if (state === 'ready') {
      return (
        <>
          <button type="button" className="engine-card__btn engine-card__btn--ghost" onClick={handleStop}>
            <span className="material-symbols-rounded" aria-hidden="true">stop</span>
            {t('engines.stop', 'Stop')}
          </button>
          {trashButton}
        </>
      );
    }
    if (state === 'update-available') {
      return (
        <>
          <button type="button" className="engine-card__btn" onClick={install}>
            <span className="material-symbols-rounded" aria-hidden="true">system_update_alt</span>
            {t('engines.update', 'Update')}
          </button>
          {trashButton}
        </>
      );
    }
    if (state === 'corrupt') {
      return (
        <button type="button" className="engine-card__btn" onClick={install}>
          <span className="material-symbols-rounded" aria-hidden="true">build</span>
          {t('engines.repair', 'Repair')}
        </button>
      );
    }
    return (
      <button type="button" className="engine-card__btn" onClick={install}>
        <span className="material-symbols-rounded" aria-hidden="true">download</span>
        {t('engines.download', 'Download')}
      </button>
    );
  };

  const busy = isInstalling || confirmUninstall || uninstalling || packageRemoving;
  const installedSize = formatBytes(packageStatus?.installedBytes);
  const downloadSize = formatBytes(packageStatus?.downloadBytes);
  const availableInstalledSize = formatBytes(packageStatus?.availableInstalledBytes);
  const packageVersion = packageStatus?.version || packageStatus?.availableVersion;
  const capacityMeta = packageStatus?.installed
    ? installedSize ? [t('engines.diskSize', '{{size}} disk', { size: installedSize })] : []
    : [
      downloadSize ? t('engines.downloadSize', '{{size}} download', { size: downloadSize }) : null,
      availableInstalledSize
        ? t('engines.diskSize', '{{size}} disk', { size: availableInstalledSize })
        : null,
    ].filter(Boolean);
  const stateMeta = [
    t(`engines.kind.${kind}`, kind),
    t(`engines.state.${state}`, state),
    packageVersion ? `v${packageVersion}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className={`engine-card engine-card--${state}${busy ? ' engine-card--busy' : ''}`}>
      <div className="engine-card__row">
        <span className="material-symbols-rounded engine-card__icon" aria-hidden="true">{STATE_ICON[state] || 'download'}</span>
        <div className="engine-card__info">
          <span className="engine-card__label">{name}</span>
          {isInstalling ? (
            <span className="engine-card__sub engine-card__sub--log" title={lastLog}>
              {lastLog || t('engines.installing', 'Installing…')}
            </span>
          ) : (
            <>
              <span className="engine-card__sub">{stateMeta}</span>
              {capacityMeta.length > 0 && (
                <span className="engine-card__state-line">{capacityMeta.join(' · ')}</span>
              )}
            </>
          )}
        </div>
        <div className="engine-card__action">{renderAction()}</div>
      </div>
      {error && <div className="engine-card__error">{error}</div>}
    </div>
  );
};

export default EngineCard;
