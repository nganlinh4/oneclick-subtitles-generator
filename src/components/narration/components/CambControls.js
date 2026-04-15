import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SERVER_URL } from '../../../config';

/**
 * Camb AI controls: voice + language picker, plus a one-click "Camb Dub" toggle.
 * Renders underneath the subtitle source selection in the narration step,
 * analogous to EdgeTTSControls / GTTSControls.
 */
const CambControls = ({
  selectedVoice,
  setSelectedVoice,
  cambLanguage,
  setCambLanguage,
  useDub,
  setUseDub,
  dubTargetLanguage,
  setDubTargetLanguage,
  isGenerating,
}) => {
  const { t } = useTranslation();
  const [voices, setVoices] = useState([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voiceError, setVoiceError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function loadVoices() {
      setLoadingVoices(true);
      setVoiceError('');
      try {
        const r = await fetch(`${SERVER_URL}/api/narration/camb/voices`);
        const data = await r.json();
        if (!cancelled) {
          if (data.voices) setVoices(data.voices);
          else setVoiceError(data.error || 'Failed to load Camb voices');
        }
      } catch (e) {
        if (!cancelled) setVoiceError(e.message);
      } finally {
        if (!cancelled) setLoadingVoices(false);
      }
    }
    loadVoices();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="narration-row camb-controls-row">
      <div className="row-label">
        <label>{t('narration.cambSettings', 'Camb AI Settings')}:</label>
      </div>
      <div className="row-content" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label htmlFor="camb-voice" style={{ marginRight: 8 }}>
            {t('narration.cambVoice', 'Voice')}:
          </label>
          <select
            id="camb-voice"
            value={selectedVoice || ''}
            onChange={(e) => setSelectedVoice(e.target.value)}
            disabled={isGenerating || loadingVoices}
          >
            <option value="">
              {loadingVoices
                ? t('narration.loadingVoices', 'Loading voices...')
                : t('narration.cambSelectVoice', 'Select a voice')}
            </option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.display_name}
              </option>
            ))}
          </select>
          {voiceError ? (
            <span style={{ color: 'var(--error, #c33)', marginLeft: 8 }}>{voiceError}</span>
          ) : null}
        </div>

        <div>
          <label htmlFor="camb-language" style={{ marginRight: 8 }}>
            {t('narration.cambLanguage', 'Language')}:
          </label>
          <input
            id="camb-language"
            type="text"
            value={cambLanguage || 'en'}
            onChange={(e) => setCambLanguage(e.target.value)}
            disabled={isGenerating}
            style={{ width: 80 }}
          />
        </div>

        {/* One-click Camb Dub toggle */}
        <div style={{ borderTop: '1px solid var(--border, #ddd)', paddingTop: 8 }}>
          <label>
            <input
              type="checkbox"
              checked={!!useDub}
              onChange={(e) => setUseDub(e.target.checked)}
              disabled={isGenerating}
            />{' '}
            {t('narration.cambDubToggle', 'Use Camb Dub (end-to-end video dubbing)')}
          </label>
          {useDub ? (
            <div style={{ marginTop: 8 }}>
              <label htmlFor="camb-dub-target" style={{ marginRight: 8 }}>
                {t('narration.cambDubTarget', 'Dub into language')}:
              </label>
              <input
                id="camb-dub-target"
                type="text"
                value={dubTargetLanguage || ''}
                onChange={(e) => setDubTargetLanguage(e.target.value)}
                placeholder="es, fr, ja, ..."
                disabled={isGenerating}
                style={{ width: 120 }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default CambControls;
