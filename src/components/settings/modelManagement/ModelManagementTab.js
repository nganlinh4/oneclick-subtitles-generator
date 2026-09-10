import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cancelNarrationModelPackageOperation,
  getNarrationModelPackageStatus,
  installNarrationModelPackage,
  removeNarrationModelPackage,
} from '../../../services/modelService';
import { invalidateModelsCache } from '../../../services/modelAvailabilityService';
import { showErrorToast, showSuccessToast } from '../../../utils/toastUtils';
import '../../../styles/settings/modelManagement.css';

const packageFailureCopy = (code) => {
  switch (code) {
    case 'packageInsufficientSpace':
      return [
        'settings.modelManagement.insufficientSpace',
        'There is not enough disk space to install this narration model. Free some space and try again.',
      ];
    case 'packageNetwork':
      return [
        'settings.modelManagement.networkFailed',
        'The narration model could not be downloaded. Check your connection and try again.',
      ];
    case 'packageIntegrity':
    case 'packageDownloadInvalid':
    case 'packageInstallInvalid':
      return [
        'settings.modelManagement.integrityFailed',
        'The downloaded narration model failed its integrity check. Try installing it again.',
      ];
    default:
      return [
        'settings.modelManagement.actionFailed',
        'The narration model operation failed.',
      ];
  }
};

const stateCopy = (t, status) => {
  if (!status) return t('settings.modelManagement.checking', 'Checking package…');
  if (status.state === 'failed') {
    return t('settings.modelManagement.statusUnavailable', 'Status unavailable');
  }
  if (status.operation) {
    const action = status.operation.action === 'remove'
      ? t('settings.modelManagement.removing', 'Removing')
      : status.operation.action === 'update'
        ? t('settings.modelManagement.updating', 'Updating')
        : t('settings.modelManagement.installing', 'Installing');
    return t('settings.modelManagement.operationProgress', '{{action}} · {{percent}}%', {
      action,
      percent: Math.round(status.operation.basisPoints / 100),
    });
  }
  if (status.state === 'unavailable') {
    return t('settings.modelManagement.unavailable', 'Unavailable in this build');
  }
  if (status.state === 'corrupt') {
    return t('settings.modelManagement.repairRequired', 'Repair required');
  }
  if (status.updateAvailable) {
    return t('settings.modelManagement.updateAvailable', 'Update available');
  }
  if (status.installed) return t('settings.modelManagement.installed', 'Installed');
  return t('settings.modelManagement.notInstalled', 'Not installed');
};

const ModelManagementTab = ({ activeTab }) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [launching, setLaunching] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const mountedRef = useRef(true);
  const refreshGenerationRef = useRef(0);

  useEffect(() => {
    // React StrictMode replays effects; every setup must restore the mounted capability that its
    // paired cleanup revoked.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshGenerationRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async ({ announceError = false } = {}) => {
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    setLoading(true);
    try {
      const next = await getNarrationModelPackageStatus();
      if (mountedRef.current && refreshGenerationRef.current === generation) setStatus(next);
      return next;
    } catch (error) {
      if (mountedRef.current && refreshGenerationRef.current === generation) {
        setStatus((current) => current ?? {
          model: null,
          deliveryAvailable: false,
          installed: false,
          updateAvailable: false,
          state: 'failed',
          version: null,
          availableVersion: null,
          installedBytes: 0,
          downloadBytes: 0,
          availableInstalledBytes: 0,
          operation: null,
        });
      }
      if (announceError) {
        showErrorToast(t(
          'settings.modelManagement.statusFailed',
          'The narration model status could not be read.'
        ));
      }
      return null;
    } finally {
      if (mountedRef.current && refreshGenerationRef.current === generation) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (activeTab !== 'model-management') return undefined;
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [activeTab, refresh]);

  useEffect(() => {
    if (activeTab !== 'model-management' || !status?.operation) return undefined;
    const timer = window.setInterval(() => refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [activeTab, refresh, status?.operation]);

  const settle = useCallback((messageKey, fallback, kind = 'success') => {
    setLaunching(null);
    setConfirmRemove(false);
    invalidateModelsCache();
    refresh();
    if (kind === 'success') showSuccessToast(t(messageKey, fallback));
    else showErrorToast(t(messageKey, fallback));
  }, [refresh, t]);

  const operationHandlers = useCallback((action) => ({
    onProgress: ({ operation }) => {
      if (mountedRef.current) setStatus((current) => (current ? { ...current, operation } : current));
    },
    onCompleted: () => settle(
      action === 'remove'
        ? 'settings.modelManagement.removedSuccess'
        : 'settings.modelManagement.installedSuccess',
      action === 'remove'
        ? 'The narration model was removed.'
        : 'The narration model is ready.'
    ),
    onCancelled: () => settle(
      'settings.modelManagement.cancelled',
      'The narration model operation was cancelled.'
    ),
    onFailed: ({ error } = {}) => {
      const [messageKey, fallback] = packageFailureCopy(error?.code);
      settle(messageKey, fallback, 'error');
    },
    onProtocolError: () => settle(
      'settings.modelManagement.actionFailed',
      'The narration model operation failed.',
      'error'
    ),
  }), [settle]);

  const runInstall = async () => {
    setLaunching('install');
    try {
      await installNarrationModelPackage(operationHandlers('install'));
      await refresh();
    } catch (error) {
      const [messageKey, fallback] = packageFailureCopy(error?.code);
      showErrorToast(t(messageKey, fallback));
    } finally {
      if (mountedRef.current) setLaunching(null);
    }
  };

  const runRemove = async () => {
    setLaunching('remove');
    setConfirmRemove(false);
    try {
      await removeNarrationModelPackage(operationHandlers('remove'));
      await refresh();
    } catch (error) {
      const [messageKey, fallback] = packageFailureCopy(error?.code);
      showErrorToast(t(messageKey, fallback));
    } finally {
      if (mountedRef.current) setLaunching(null);
    }
  };

  const runCancel = async () => {
    setLaunching('cancel');
    try {
      await cancelNarrationModelPackageOperation();
      await refresh();
    } catch {
      showErrorToast(t('settings.modelManagement.cancelFailed', 'The operation could not be cancelled.'));
    } finally {
      if (mountedRef.current) setLaunching(null);
    }
  };

  const busy = Boolean(launching || status?.operation);
  const installLabel = status?.state === 'corrupt'
    ? t('settings.modelManagement.repair', 'Repair')
    : status?.updateAvailable
      ? t('settings.modelManagement.update', 'Update')
      : t('settings.modelManagement.install', 'Install');

  return (
    <section
      className="narration-model-panel"
      data-model-package-state={status?.state ?? 'checking'}
    >
      <p className="model-management-description">
        {t('settings.modelManagement.description', 'Manage F5-TTS models for narration.')}
      </p>

      {status?.installed ? <div className="model-management-section">
        <div className="section-header">
          <h4>{t('settings.modelManagement.installedModels', 'Installed Models')}</h4>
          <button type="button" className="refresh-models-btn" onClick={() => refresh({ announceError: true })} disabled={busy || loading}>
            <span className={`material-symbols-rounded ${loading ? 'spinning' : ''}`} aria-hidden="true">refresh</span>
            {t('settings.modelManagement.refresh', 'Refresh')}
          </button>
        </div>
        <div className="model-cards-container">
          <article className="model-card installed-model" data-model-package-id="f5tts-v1-base">
            <div className="model-card-content narration-model-package__body">
              <h5 className="model-title">F5-TTS v1 Base</h5>
              <p className="model-source">{t('settings.modelManagement.source', 'Source')}: F5-TTS</p>
              <div className="model-languages"><span className="language-chip zh">Chinese</span><span className="language-chip en">English</span></div>
              <span className={`narration-model-package__state state-${status?.state ?? 'checking'}`}>{stateCopy(t, status)}</span>
              {status?.operation ? <div className="narration-model-package__progress"><div style={{ width: `${status.operation.basisPoints / 100}%` }} /></div> : null}
            </div>
            <div className="model-card-actions narration-model-package__actions">
              {status?.operation ? <button type="button" data-model-action="cancel" onClick={runCancel} disabled={launching === 'cancel'}>{t('settings.modelManagement.cancel', 'Cancel')}</button> : null}
              {!status?.operation && (status?.state === 'corrupt' || status?.updateAvailable) ? <button type="button" className="download-model-btn" data-model-action="install" onClick={runInstall} disabled={busy}>{installLabel}</button> : null}
              {!status?.operation && !confirmRemove ? <button type="button" data-model-action="remove" className="delete-model-btn" onClick={() => setConfirmRemove(true)} disabled={busy}>{t('settings.modelManagement.remove', 'Remove')}</button> : null}
              {!status?.operation && confirmRemove ? <div className="narration-model-package__confirm"><button type="button" data-model-action="confirm-remove" className="delete-model-btn" onClick={runRemove}>{t('settings.modelManagement.confirm', 'Confirm')}</button><button type="button" data-model-action="keep" onClick={() => setConfirmRemove(false)}>{t('settings.modelManagement.keep', 'Keep')}</button></div> : null}
            </div>
          </article>
        </div>
      </div> : null}

      {!status?.installed ? <div className="model-management-section">
        <div className="section-header">
          <h4>{t('settings.modelManagement.availableModels', 'Available Models')}</h4>
          <button type="button" className="refresh-models-btn" onClick={() => refresh({ announceError: true })} disabled={busy || loading}>
            <span className={`material-symbols-rounded ${loading ? 'spinning' : ''}`} aria-hidden="true">refresh</span>
            {t('settings.modelManagement.refresh', 'Refresh')}
          </button>
        </div>
        <div className="model-cards-container">
          <article className="model-card" data-model-package-id="f5tts-v1-base">
            <div className="model-card-content">
              <h5 className="model-title">F5-TTS v1 Base</h5>
              <p className="model-author">{t('settings.modelManagement.by', 'by')} F5-TTS</p>
              <div className="model-languages"><span className="language-chip zh">Chinese</span><span className="language-chip en">English</span></div>
              <span className={`narration-model-package__state state-${status?.state ?? 'checking'}`}>{stateCopy(t, status)}</span>
              {status?.operation ? <div className="narration-model-package__progress"><div style={{ width: `${status.operation.basisPoints / 100}%` }} /></div> : null}
            </div>
            <div className="model-card-actions">
              {status?.operation ? <button type="button" className="cancel-download-btn" data-model-action="cancel" onClick={runCancel} disabled={launching === 'cancel'}>{t('settings.modelManagement.cancel', 'Cancel')}</button> : <button type="button" className="download-model-btn" data-model-action="install" onClick={runInstall} disabled={busy || !status?.deliveryAvailable}>{installLabel}</button>}
            </div>
          </article>
        </div>
      </div> : null}
    </section>
  );
};

export default ModelManagementTab;
