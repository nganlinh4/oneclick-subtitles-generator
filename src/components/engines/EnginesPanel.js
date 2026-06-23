import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEngineStatus } from '../../hooks/useEngineStatus';
import { API_BASE_URL } from '../../config';
import LoadingIndicator from '../common/LoadingIndicator';
import { useWaveColors } from '../../utils/waveColors';
import EngineCard from './EngineCard';
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

  // Single source of truth: the status probe reports managedByElectron (isPackaged) per engine, the
  // same condition the server uses to reject manual installs — no separate startup-mode flag.
  const managedByElectron = ENGINES.some((e) => engines[e.id]?.managedByElectron);
  const installedEngines = ENGINES.filter((e) => engines[e.id]?.installed);

  const handleUninstallAll = async () => {
    setConfirmAll(false);
    setUninstallingAll(true);
    try {
      await Promise.all(installedEngines.map((e) =>
        fetch(`${API_BASE_URL}/engines/${e.id}/uninstall`, { method: 'POST' }).catch(() => {})
      ));
      refresh();
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
      {ENGINES.map((e) => (
        <EngineCard
          key={e.id}
          id={e.id}
          name={e.name}
          kind={e.kind}
          status={engines[e.id]}
          onChanged={refresh}
          managedByElectron={managedByElectron}
        />
      ))}
    </div>
  );
};

export default EnginesPanel;
