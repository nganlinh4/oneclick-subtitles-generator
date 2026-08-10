import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEngineStatus } from '../../hooks/useEngineStatus';
import { removeManagedEnginePackage } from '../../platform/managedEngineService';
import { getEnginePackagesStatus } from '../../platform/enginePackageService';
import { getSpeechPackagesStatus } from '../../platform/speechPackageService';
import LoadingIndicator from '../common/LoadingIndicator';
import { useWaveColors } from '../../utils/waveColors';
import EngineCard from './EngineCard';
import NativeToolsList from './NativeToolsList';
import { ASR_ENGINES } from '../../services/engines/asrEngines';
import './engines.css';

// The heavy engines users can install on demand. `base` is always-installed plumbing, not shown.
// `name` is a proper noun (never translated); `kind` keys into engines.kind.* for the descriptor.
// The catalog ASR engines (faster-whisper, qwen3-asr, …) are derived from asrEngines so adding an
// engine there makes it appear here automatically — no second list to keep in sync.
const ENGINES = [
  { id: 'f5tts', name: 'F5-TTS', kind: 'voice-cloning' },
  { id: 'chatterbox', name: 'Chatterbox', kind: 'voice-cloning' },
  { id: 'parakeet', name: 'Nvidia Parakeet', kind: 'transcription' },
  ...ASR_ENGINES.map((e) => ({ id: e.id, name: e.name, kind: 'transcription' })),
];

const PACKAGE_ID_BY_ENGINE = Object.freeze({
  f5tts: 'f5-tts',
  chatterbox: 'chatterbox',
});

export const mapManagedPackageInventory = (
  asrStatus = { engines: [] },
  speechStatus = { packages: [] }
) => {
  const packages = new Map();
  asrStatus.engines.forEach((entry) => packages.set(entry.id, entry));
  speechStatus.packages.forEach((entry) => {
    const engine = Object.entries(PACKAGE_ID_BY_ENGINE)
      .find(([, packageId]) => packageId === entry.id)?.[0];
    if (engine) packages.set(engine, entry);
  });
  return packages;
};

export const removeNativeEnginePackage = (engine) => new Promise((resolve) => {
  const settle = () => resolve();
  Promise.resolve()
    .then(() => removeManagedEnginePackage(engine, {
      onCompleted: settle,
      onCancelled: settle,
      onFailed: settle,
      onProtocolError: settle,
    }))
    .catch(settle);
});

/**
 * Settings panel listing the heavy engines, each with an on-demand Download / Start / Stop / Uninstall
 * control, plus an "Uninstall all" action to reclaim disk in one go.
 */
const EnginesPanel = () => {
  const { t } = useTranslation();
  const { engines, refresh } = useEngineStatus();
  const { isDarkTheme, waveColor } = useWaveColors();
  const [confirmAll, setConfirmAll] = useState(false);
  const [uninstallingAll, setUninstallingAll] = useState(false);
  const [packages, setPackages] = useState(() => new Map());
  const [packageStatusState, setPackageStatusState] = useState('checking');
  const [failedPackages, setFailedPackages] = useState(() => new Set());

  const refreshPackages = useCallback(async () => {
    setPackageStatusState('checking');
    const [asr, speech] = await Promise.allSettled([
      getEnginePackagesStatus(),
      getSpeechPackagesStatus(),
    ]);
    const failed = new Set();
    if (asr.status === 'rejected') {
      ENGINES.filter((engine) => !(engine.id in PACKAGE_ID_BY_ENGINE))
        .forEach((engine) => failed.add(engine.id));
    }
    if (speech.status === 'rejected') {
      Object.keys(PACKAGE_ID_BY_ENGINE).forEach((engine) => failed.add(engine));
    }
    setFailedPackages(failed);
    if (asr.status === 'rejected' && speech.status === 'rejected') {
      setPackageStatusState('failed');
      return;
    }
    const next = mapManagedPackageInventory(
      asr.status === 'fulfilled' ? asr.value : undefined,
      speech.status === 'fulfilled' ? speech.value : undefined
    );
    setPackages((current) => new Map([...current, ...next]));
    setPackageStatusState('ready');
  }, []);

  const refreshAll = useCallback(() => {
    refresh();
    refreshPackages().catch(() => {});
  }, [refresh, refreshPackages]);

  useEffect(() => {
    refreshPackages().catch(() => {});
    const refreshOnFocus = () => refreshPackages().catch(() => {});
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [refreshPackages]);

  // Single source of truth: the status probe reports managedByElectron (isPackaged) per engine, the
  // same condition the server uses to reject manual installs — no separate startup-mode flag.
  const managedByElectron = ENGINES.some((e) => engines[e.id]?.managedByElectron);
  const installedEngines = ENGINES.filter((engine) => packages.get(engine.id)?.installed);
  const availableEngines = useMemo(
    () => ENGINES.filter((engine) => packages.get(engine.id)?.deliveryAvailable).length,
    [packages]
  );

  const handleUninstallAll = async () => {
    setConfirmAll(false);
    setUninstallingAll(true);
    try {
      await Promise.all(installedEngines.map((engine) => removeNativeEnginePackage(engine.id)));
      refreshAll();
    } finally {
      setUninstallingAll(false);
    }
  };

  const renderUninstallAll = () => {
    if (managedByElectron || installedEngines.length === 0) return null;
    if (uninstallingAll) {
      return (
        <div className="engine-card__loading">
          <LoadingIndicator theme={isDarkTheme ? 'light' : 'dark'} showContainer={false} size={16} color={waveColor} />
          <span className="engine-card__loading-text">{t('engines.uninstalling', 'Uninstalling…')}</span>
        </div>
      );
    }
    if (confirmAll) {
      return (
        <div className="engines-panel__confirm-all">
          <span className="engine-card__confirm-text">{t('engines.confirmUninstallAll', 'Uninstall all engines?')}</span>
          <button type="button" className="engine-card__btn engine-card__btn--danger" onClick={handleUninstallAll}>
            {t('engines.uninstallAll', 'Uninstall all')}
          </button>
          <button type="button" className="engine-card__btn engine-card__btn--ghost" onClick={() => setConfirmAll(false)}>
            {t('engines.cancel', 'Cancel')}
          </button>
        </div>
      );
    }
    return (
      <button type="button" className="engines-panel__uninstall-all" onClick={() => setConfirmAll(true)}>
        <span className="material-symbols-rounded" aria-hidden="true">delete_sweep</span>
        {t('engines.uninstallAll', 'Uninstall all')}
      </button>
    );
  };

  return (
    <div className="engines-panel">
      <div className="engines-panel__header">
        <p className="engines-panel__intro">
          {managedByElectron
            ? t('engines.electronManaged', 'The desktop app includes these engines. Downloads are managed by the app package.')
            : t('engines.intro', 'Voice-cloning and local transcription engines install on demand — a one-time ~3 GB GPU download per engine. Install only what you need.')}
        </p>
        {renderUninstallAll()}
      </div>
      <div className="tools-ledger">
        <section className="tools-ledger__group" aria-labelledby="local-ai-tools-heading">
          <div className="tools-ledger__heading">
            <div>
              <h3 id="local-ai-tools-heading">{t('engines.groups.localAi', 'Local AI engines')}</h3>
              <span>{t('engines.groups.localAiDetail', 'Voice cloning and transcription')}</span>
            </div>
            <span className="tools-ledger__count">
              {t('engines.availableCount', '{{available}} available · {{installed}} installed', {
                available: availableEngines,
                installed: installedEngines.length,
              })}
            </span>
          </div>
          <div className="engines-panel__grid">
            {ENGINES.map((engine) => (
              <EngineCard
                key={engine.id}
                id={engine.id}
                name={engine.name}
                kind={engine.kind}
                status={{ ...engines[engine.id], package: packages.get(engine.id) }}
                onChanged={refreshAll}
                managedByElectron={managedByElectron}
                packageStatusState={failedPackages.has(engine.id) ? 'failed' : packageStatusState}
              />
            ))}
          </div>
        </section>
        <NativeToolsList />
      </div>
    </div>
  );
};

export default EnginesPanel;
