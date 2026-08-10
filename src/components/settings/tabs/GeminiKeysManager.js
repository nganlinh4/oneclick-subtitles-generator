import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAllKeys, addKey, removeKey, getActiveKeyIndex, setActiveKeyIndex } from '../../../services/gemini/keyManager';
import {
  addGeminiCredential,
  formatCredentialReference,
  getCredentialAvailability,
  initializeCredentialState,
  removeGeminiCredential,
  selectGeminiCredential,
  subscribeCredentialState,
} from '../../../platform/credentialStateController';
import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { animateToggle, toggleKeyVisibility } from '../utils/keyVisibilityAnimation';

// Hook owning the multiple Gemini API key state + handlers.
export const useGeminiKeys = ({ setGeminiApiKey, setApiKeysSet }) => {
  const nativeCredentialMode = isDesktopRuntime();
  const [geminiApiKeys, setGeminiApiKeys] = useState([]);
  const [newGeminiKey, setNewGeminiKey] = useState('');
  const [showNewGeminiKey, setShowNewGeminiKey] = useState(false);
  const [activeKeyIndex, setActiveKeyIndexState] = useState(0);
  const [visibleKeyIndices, setVisibleKeyIndices] = useState({});
  const credentialIdByReference = useRef(new Map());
  const nativeAddPending = useRef(false);

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
  }, [setApiKeysSet]);

  // Load all Gemini API keys on mount
  useEffect(() => {
    if (nativeCredentialMode) {
      let mounted = true;
      const unsubscribe = subscribeCredentialState((snapshot) => {
        if (mounted) applyNativeSnapshot(snapshot);
      });
      initializeCredentialState().catch(() => {
        if (mounted) {
          setApiKeysSet((previous) => ({ ...previous, gemini: false }));
        }
      });
      return () => {
        mounted = false;
        unsubscribe();
      };
    }

    const keys = getAllKeys();
    setGeminiApiKeys(keys);
    setActiveKeyIndexState(getActiveKeyIndex());
    return undefined;
  }, [applyNativeSnapshot, nativeCredentialMode, setApiKeysSet]);

  // Update the active key when it changes
  const handleSetActiveKey = async (index) => {
    if (nativeCredentialMode) {
      const reference = geminiApiKeys[index];
      const id = credentialIdByReference.current.get(reference);
      if (!id) return false;
      try {
        await selectGeminiCredential(id);
        return true;
      } catch {
        return false;
      }
    }

    setActiveKeyIndex(index);
    setActiveKeyIndexState(index);
    // Update the single key for backward compatibility
    setGeminiApiKey(geminiApiKeys[index]);
    return true;
  };

  // Add a new Gemini API key
  const handleAddGeminiKey = async () => {
    if (newGeminiKey && newGeminiKey.trim()) {
      if (nativeCredentialMode) {
        if (nativeAddPending.current) return false;
        nativeAddPending.current = true;
        const secret = newGeminiKey;
        // Clear the write-only field before crossing the IPC boundary. The local variable exists
        // only for this one submit call and is never copied into durable or shared React state.
        setNewGeminiKey('');
        try {
          await addGeminiCredential(secret);
          setShowNewGeminiKey(false);
          return true;
        } catch {
          return false;
        } finally {
          nativeAddPending.current = false;
        }
      }

      if (addKey(newGeminiKey)) {
        const updatedKeys = getAllKeys();
        setGeminiApiKeys(updatedKeys);
        setNewGeminiKey('');
        setShowNewGeminiKey(false);

        // Update API keys set status
        setApiKeysSet(prevState => ({
          ...prevState,
          gemini: true
        }));
        return true;
      }
    }
    return false;
  };

  // Remove a Gemini API key
  const handleRemoveGeminiKey = async (key) => {
    if (nativeCredentialMode) {
      const id = credentialIdByReference.current.get(key);
      if (!id) return false;
      try {
        return await removeGeminiCredential(id);
      } catch {
        return false;
      }
    }

    if (removeKey(key)) {
      const updatedKeys = getAllKeys();
      setGeminiApiKeys(updatedKeys);

      // Update API keys set status
      setApiKeysSet(prevState => ({
        ...prevState,
        gemini: updatedKeys.length > 0
      }));
      return true;
    }
    return false;
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
    handleSetActiveKey,
    handleAddGeminiKey,
    handleRemoveGeminiKey,
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
  setVisibleKeyIndices,
  handleSetActiveKey,
  handleAddGeminiKey,
  handleRemoveGeminiKey,
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
                          {key}
                        </div>
                      </div>
                    </div>
                    <div className="gemini-key-actions expanded">
                      <button
                        type="button"
                        className="gemini-key-button"
                        onClick={() => toggleKeyVisibility(index, setVisibleKeyIndices)}
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
                          <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>close</span>
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="gemini-key-row">
                    <div
                      className="gemini-key-text gemini-key-masked"
                      title={key}
                    >
                      {key ? `${key.substring(0, 4)}••••••${key.substring(key.length - 4)}` : ''}
                    </div>
                    <div className="gemini-key-actions">
                      <button
                        type="button"
                        className="gemini-key-button"
                        onClick={() => toggleKeyVisibility(index, setVisibleKeyIndices)}
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
                        <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>close</span>
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
