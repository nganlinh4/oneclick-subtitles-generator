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
};

const EngineCard = ({ id, name, kind, status, onChanged, managedByElectron = false }) => {
  const { t } = useTranslation();
  const { install, cancel, start, stop, uninstall, installing, percent, log, error } = useEngineInstall(id);
  const state = managedByElectron
    ? (status?.running ? 'ready' : 'included')
    : (status?.state || 'not-installed');
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
    if (installing) {
      return (
        <div className="engine-card__installing">
          <LoadingIndicator theme={isDarkTheme ? 'light' : 'dark'} showContainer={false} size={16} color={waveColor} />
          <div className="engine-card__wavy">
            <WavyProgressIndicator
              progress={Math.max(0, Math.min(1, (percent || 0) / 100))}
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
          <button type="button" className="engine-card__cancel" onClick={cancel} title={t('engines.cancel', 'Cancel')} aria-label={t('engines.cancel', 'Cancel')}>
            <span className="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </div>
      );
    }
    if (uninstalling) return loadingRow('engines.uninstalling', 'Uninstalling…');
    if (managedByElectron) return <span className="engine-card__managed">{t('engines.included', 'Included')}</span>;
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
    return (
      <button type="button" className="engine-card__btn" onClick={install}>
        <span className="material-symbols-rounded" aria-hidden="true">download</span>
        {t('engines.download', 'Download')}
      </button>
    );
  };

  const busy = installing || confirmUninstall || uninstalling;

  return (
    <div className={`engine-card engine-card--${state}${busy ? ' engine-card--busy' : ''}`}>
      <div className="engine-card__row">
        <span className="material-symbols-rounded engine-card__icon" aria-hidden="true">{STATE_ICON[state] || 'download'}</span>
        <div className="engine-card__info">
          <span className="engine-card__label">{name}</span>
          {installing ? (
            <span className="engine-card__sub engine-card__sub--log" title={lastLog}>
              {lastLog || t('engines.installing', 'Installing…')}
            </span>
          ) : (
            <span className="engine-card__sub">
              {t(`engines.kind.${kind}`, kind)} · {t(`engines.state.${state}`, state)}
            </span>
          )}
        </div>
        <div className="engine-card__action">{renderAction()}</div>
      </div>
      {error && <div className="engine-card__error">{error}</div>}
    </div>
  );
};

export default EngineCard;
