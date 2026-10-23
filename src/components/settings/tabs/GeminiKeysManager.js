import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addGeminiCredential,
  formatCredentialReference,
  getCredentialAvailability,
  initializeCredentialState,
  removeGeminiCredential,
  selectGeminiCredential,
  subscribeCredentialState,
} from '../../../platform/credentialStateController';
import { revealCredential } from '../../../platform/credentialService';
import { animateToggle } from '../utils/keyVisibilityAnimation';
import { showToast } from '../../../utils/toastUtils';

// Hook owning the multiple Gemini API key state + handlers. Keys live in the native credential
// vault; React only ever holds masked references and an on-demand revealed value.
export const useGeminiKeys = ({ setApiKeysSet }) => {
  const { t } = useTranslation();
  const [geminiApiKeys, setGeminiApiKeys] = useState([]);
  const [newGeminiKey, setNewGeminiKey] = useState('');
  const [showNewGeminiKey, setShowNewGeminiKey] = useState(false);
  const [activeKeyIndex, setActiveKeyIndexState] = useState(0);
  const [visibleKeyIndices, setVisibleKeyIndices] = useState({});
  const [revealedKeyValues, setRevealedKeyValues] = useState({});
  const credentialIdByReference = useRef(new Map());
  const nativeAddPending = useRef(false);
  const preferenceWarningShown = useRef(false);

  const applyNativeSnapshot = useCallback((snapshot) => {
    if (!snapshot.initialized) return;
    const credentials = snapshot.credentials.filter(({ purpose }) => purpose === 'geminiApiKey');
    const references = credentials.map(formatCredentialReference);
    credentialIdByReference.current = new Map(
      references.map((reference, index) => [reference, credentials[index].id])
    );
    setGeminiApiKeys(references);
    setActiveKeyIndexState(snapshot.gemini.activeIndex < 0 ? 0 : snapshot.gemini.activeIndex);
    setApiKeysSet((previous) => ({
      ...previous,
      gemini: getCredentialAvailability(snapshot).gemini,
    }));
    if (snapshot.selectionPersistenceFailed && !preferenceWarningShown.current) {
      showToast(t('settings.credentialPreferenceSaveFailed', 'Only the preferred-key setting could not be saved. Reopen Settings to retry.'), 'warning', 8000);
    }
    preferenceWarningShown.current = Boolean(snapshot.selectionPersistenceFailed);
  }, [setApiKeysSet, t]);

  const reportMutationFailure = () => showToast(t(
    'settings.credentialChangeFailed',
    'The key change could not be confirmed. Check the saved-key list before trying again.',
  ), 'error', 8000);

  // Load all Gemini API keys on mount
  useEffect(() => {
    let mounted = true;
    const unsubscribe = subscribeCredentialState((snapshot) => {
      if (mounted) applyNativeSnapshot(snapshot);
    });
    initializeCredentialState().catch(() => {
      if (mounted) {
        setApiKeysSet((previous) => ({ ...previous, gemini: false }));
        showToast(t('settings.credentialLoadFailed', 'Saved keys could not be loaded. Reopen Settings to retry.'), 'error', 8000);
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [applyNativeSnapshot, setApiKeysSet, t]);

  const handleSetActiveKey = async (index) => {
    const id = credentialIdByReference.current.get(geminiApiKeys[index]);
    if (!id) return false;
    try {
      await selectGeminiCredential(id);
      return true;
    } catch {
      reportMutationFailure();
      return false;
    }
  };

  const handleAddGeminiKey = async () => {
    if (!newGeminiKey || !newGeminiKey.trim() || nativeAddPending.current) return false;
    nativeAddPending.current = true;
    const secret = newGeminiKey;
    // Clear the write-only field before crossing the IPC boundary. The local variable exists
    // only for this one submit call and is never copied into durable or shared React state.
    setNewGeminiKey('');
    try {
      await addGeminiCredential(secret);
      setShowNewGeminiKey(false);
      showToast(t('settings.credentialAdded', 'Key saved. You can use Gemini now; no need to click Save.'), 'success');
      return true;
    } catch {
      reportMutationFailure();
      return false;
    } finally {
      nativeAddPending.current = false;
    }
  };

  const handleRemoveGeminiKey = async (key) => {
    const id = credentialIdByReference.current.get(key);
    if (!id) return false;
    try {
      return await removeGeminiCredential(id);
    } catch {
      reportMutationFailure();
      return false;
    }
  };

  const handleToggleKeyVisibility = async (index) => {
    if (visibleKeyIndices[index]) {
      setVisibleKeyIndices((current) => ({ ...current, [index]: false }));
      setRevealedKeyValues((current) => ({ ...current, [index]: '' }));
      return;
    }
    const id = credentialIdByReference.current.get(geminiApiKeys[index]);
    if (!id) return;
    try {
      const secret = await revealCredential(id);
      setRevealedKeyValues((current) => ({ ...current, [index]: secret }));
      setVisibleKeyIndices((current) => ({ ...current, [index]: true }));
    } catch {
      window.addToast?.(t('settings.credentialRevealFailed', 'The saved key could not be shown.'), 'error', 8000);
    }
  };

  return {
    geminiApiKeys,
    newGeminiKey,
    setNewGeminiKey,
    showNewGeminiKey,
    setShowNewGeminiKey,
    activeKeyIndex,
    visibleKeyIndices,
    setVisibleKeyIndices,
    revealedKeyValues,
    handleSetActiveKey,
    handleAddGeminiKey,
    handleRemoveGeminiKey,
    handleToggleKeyVisibility,
  };
};

// Presentational component rendering the multi-key management UI.
const GeminiKeysManager = ({
  geminiApiKeys,
  newGeminiKey,
  setNewGeminiKey,
  showNewGeminiKey,
  setShowNewGeminiKey,
  activeKeyIndex,
  visibleKeyIndices,
  revealedKeyValues,
  handleSetActiveKey,
  handleAddGeminiKey,
  handleRemoveGeminiKey,
  handleToggleKeyVisibility,
}) => {
  const { t } = useTranslation();
  const newGeminiKeyRef = useRef(null);

  useEffect(() => {
    if (showNewGeminiKey && newGeminiKeyRef.current) {
      newGeminiKeyRef.current.focus();
    }
  }, [showNewGeminiKey]);

  return (
    <div className="gemini-keys-container">
      {geminiApiKeys.length > 0 ? (
        <div className="gemini-keys-list">
          {geminiApiKeys.map((key, index) => (
            <div
              key={`gemini-key-${index}`}
              id={`gemini-key-${index}`}
              className={`gemini-key-item ${index === activeKeyIndex ? 'active' : ''} ${geminiApiKeys.length === 1 ? 'single-key' : ''}`}
            >
              <div className="gemini-key-content">
                {visibleKeyIndices[index] ? (
                  <>
                    <div className="gemini-key-display">
                      <div className="gemini-key-text">
                        <div className="gemini-key-visible">
                          {revealedKeyValues[index]}
                        </div>
                      </div>
                    </div>
                    <div className="gemini-key-actions expanded">
                      <button
                        type="button"
                        className="gemini-key-button"
                        onClick={() => handleToggleKeyVisibility(index)}
                        title={t('settings.hideKey', 'Hide key')}
                      >
                        {t('settings.hide', 'Hide')}
                      </button>
                      <div className="gemini-key-actions-right">
                        <button
                          type="button"
                          className={`gemini-key-button ${index === activeKeyIndex ? 'active' : ''}`}
                          onClick={() => handleSetActiveKey(index)}
                          disabled={index === activeKeyIndex}
                          title={t('settings.setAsActive', 'Set as active key')}
                        >
                          {index === activeKeyIndex ?
                            t('settings.activeKey', 'Active') :
                            t('settings.setActive', 'Set Active')}
                        </button>
                        <button
                          type="button"
                          className="remove-key"
                          onClick={() => handleRemoveGeminiKey(key)}
                          title={t('settings.removeKey', 'Remove key')}
                        >
                          <span aria-hidden="true" className="material-symbols-rounded" style={{ fontSize: '16px' }}>close</span>
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="gemini-key-row">
                    <div className="gemini-key-text gemini-key-masked">•••••••• {key.slice(-4)}</div>
                    <div className="gemini-key-actions">
                      <button
                        type="button"
                        className="gemini-key-button"
                        onClick={() => handleToggleKeyVisibility(index)}
                        title={t('settings.showKey', 'Show key')}
                      >
                        {t('settings.show', 'Show')}
                      </button>
                      <button
                        type="button"
                        className={`gemini-key-button ${index === activeKeyIndex ? 'active' : ''}`}
                        onClick={() => handleSetActiveKey(index)}
                        disabled={index === activeKeyIndex}
                        title={t('settings.setAsActive', 'Set as active key')}
                      >
                        {index === activeKeyIndex ?
                          t('settings.activeKey', 'Active') :
                          t('settings.setActive', 'Set Active')}
                      </button>
                      <button
                        type="button"
                        className="remove-key"
                        onClick={() => handleRemoveGeminiKey(key)}
                        title={t('settings.removeKey', 'Remove key')}
                      >
                        <span aria-hidden="true" className="material-symbols-rounded" style={{ fontSize: '16px' }}>close</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

            </div>
          ))}
        </div>
      ) : (
        <div className="no-keys-message">
          {t('settings.noGeminiKeys', 'No Gemini API keys added yet. Add your first key below.')}
        </div>
      )}

      {/* Add new key input */}
      <div className="add-new-key-container">
        <div className="add-key-input-row">
          <div className="custom-api-key-input">
            <div className="custom-input-field">
              <input
                type="text"
                id="new-gemini-key-input"
                className={`api-key-input-field ${!showNewGeminiKey ? 'masked-input' : ''}`}
                value={newGeminiKey}
                onChange={(e) => setNewGeminiKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddGeminiKey();
                  }
                }}
                placeholder={t('settings.addGeminiKeyPlaceholder', 'Enter a new Gemini API key')}
                ref={newGeminiKeyRef}
                autoComplete="new-password"
                data-lpignore="true"
                data-form-type="other"
                spellCheck="false"
              />
            </div>
            <button
              type="button"
              className="toggle-visibility"
              onClick={() => animateToggle('new-gemini-key-input', showNewGeminiKey, setShowNewGeminiKey)}
              aria-label={showNewGeminiKey ? t('settings.hide') : t('settings.show')}
            >
              {showNewGeminiKey ? t('settings.hide') : t('settings.show')}
            </button>
          </div>
          <button
            type="button"
            className="add-key-button"
            onClick={handleAddGeminiKey}
            disabled={!newGeminiKey}
          >
            {t('settings.addKey', 'Add Key')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GeminiKeysManager;
