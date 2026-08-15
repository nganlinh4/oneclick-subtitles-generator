import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getName } from 'iso-639-1';
import {
  getSpeechLifecycleSnapshot,
  getSpeechVoiceInventory,
  subscribeSpeechLifecycle,
} from '../../../platform/speechService';
import MaterialSwitch from '../../common/MaterialSwitch';
import CustomDropdown from '../../common/CustomDropdown';
import LanguageSelectionModal from './LanguageSelectionModal';
import '../../../styles/narration/narrationAdvancedSettingsRedesign.css';
import '../../../styles/narration/narrationModelDropdown.css';

/**
 * gTTS Controls component for language selection and speech parameters
 * @param {Object} props - Component props
 * @param {string} props.selectedLanguage - Currently selected language
 * @param {Function} props.setSelectedLanguage - Function to set selected language
 * @param {string} props.tld - Current top-level domain for accent
 * @param {Function} props.setTld - Function to set TLD
 * @param {boolean} props.slow - Whether to speak slowly
 * @param {Function} props.setSlow - Function to set slow speech
 * @param {boolean} props.isGenerating - Whether generation is in progress
 * @param {Object} props.detectedLanguage - Detected language from subtitles
 * @returns {JSX.Element} - Rendered component
 */
const GTTSControls = ({
  selectedLanguage,
  setSelectedLanguage,
  tld,
  setTld,
  slow,
  setSlow,
  isGenerating,
  detectedLanguage,
  isServiceAvailable = false
}) => {
  const { t } = useTranslation();
  const [languages, setLanguages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inventoryAvailable, setInventoryAvailable] = useState(false);
  const [lifecycle, setLifecycle] = useState(() => getSpeechLifecycleSnapshot('gtts'));
  const [isLanguageModalOpen, setIsLanguageModalOpen] = useState(false);
  const languageRequestSequence = useRef(0);

  useEffect(() => subscribeSpeechLifecycle((snapshot) => {
    if (snapshot.backend === 'gtts') setLifecycle(snapshot);
  }), []);

  // Language inventory is requested only for an already-running engine. Tools owns Start/Stop.
  useEffect(() => {
    const sequence = languageRequestSequence.current + 1;
    languageRequestSequence.current = sequence;
    if (!isServiceAvailable
        || !lifecycle?.enabled
        || !lifecycle.warm) {
      setLanguages([]);
      setInventoryAvailable(false);
      setLoading(false);
      return () => { languageRequestSequence.current += 1; };
    }
    const loadLanguages = async () => {
      try {
        setLoading(true);
        const inventory = await getSpeechVoiceInventory('gtts', lifecycle.epoch);
        if (languageRequestSequence.current !== sequence) return;
        const currentLifecycle = getSpeechLifecycleSnapshot('gtts');
        if (!currentLifecycle?.enabled
            || !currentLifecycle.warm
            || currentLifecycle.epoch !== inventory.epoch) return;
        const data = {
          languages: inventory.voices.map((voice) => ({
            code: voice.id,
            name: voice.displayName,
          })),
        };
        setLanguages(data.languages || []);
        setInventoryAvailable(data.languages.length > 0);
      } catch (err) {
        if (languageRequestSequence.current !== sequence) return;
        setLanguages([]);
        setInventoryAvailable(false);
        console.error('Error loading gTTS languages:', err);
        window.addToast(t('narration.languageLoadError', 'Error loading languages: Failed to load languages'), 'error');
      } finally {
        if (languageRequestSequence.current === sequence) setLoading(false);
      }
    };

    loadLanguages();
    return () => {
      if (languageRequestSequence.current === sequence) languageRequestSequence.current += 1;
    };
  }, [isServiceAvailable, lifecycle?.enabled, lifecycle?.epoch, lifecycle?.warm, t]);

  useEffect(() => {
    if (!isServiceAvailable
        || !inventoryAvailable
        || selectedLanguage
        || languages.length === 0) return;
    const matchingLanguage = detectedLanguage?.languageCode
      ? languages.find(({ code }) => code === detectedLanguage.languageCode)
      : null;
    setSelectedLanguage((matchingLanguage || languages.find(({ code }) => code === 'en') || languages[0]).code);
  }, [
    detectedLanguage,
    inventoryAvailable,
    isServiceAvailable,
    languages,
    selectedLanguage,
    setSelectedLanguage,
  ]);

  // Handle TLD change
  const handleTldChange = (e) => {
    const newTld = e.target.value;
    setTld(newTld);
  };

  // Handle slow speech toggle
  const handleSlowChange = (e) => {
    const newSlow = e.target.checked;
    setSlow(newSlow);
  };

  // TLD options grouped by language
  const tldOptionsByLanguage = useMemo(() => ({
    'en': [
      { value: 'com', label: t('narration.tldCom', 'Global (.com)') },
      { value: 'com.au', label: t('narration.tldAu', 'Australian (.com.au)') },
      { value: 'co.uk', label: t('narration.tldUk', 'British (.co.uk)') },
      { value: 'us', label: t('narration.tldUs', 'American (.us)') },
      { value: 'ca', label: t('narration.tldCa', 'Canadian (.ca)') },
      { value: 'co.in', label: t('narration.tldIn', 'Indian (.co.in)') },
      { value: 'ie', label: t('narration.tldIe', 'Irish (.ie)') },
      { value: 'co.za', label: t('narration.tldZa', 'South African (.co.za)') }
    ],
    'pt': [
      { value: 'com', label: t('narration.tldCom', 'Global (.com)') },
      { value: 'com.br', label: t('narration.tldBr', 'Brazilian (.com.br)') },
      { value: 'pt', label: t('narration.tldPt', 'Portuguese (.pt)') }
    ],
    'es': [
      { value: 'com', label: t('narration.tldCom', 'Global (.com)') },
      { value: 'es', label: t('narration.tldEs', 'Spanish (.es)') },
      { value: 'com.mx', label: t('narration.tldMx', 'Mexican (.com.mx)') }
    ],
    'fr': [
      { value: 'com', label: t('narration.tldCom', 'Global (.com)') },
      { value: 'fr', label: t('narration.tldFr', 'French (.fr)') },
      { value: 'ca', label: t('narration.tldCa', 'Canadian (.ca)') }
    ]
  }), [t]);

  // Get TLD options for the selected language, fallback to global options
  const getTldOptions = useCallback(() => {
    return tldOptionsByLanguage[selectedLanguage] || [
      { value: 'com', label: t('narration.tldCom', 'Global (.com)') }
    ];
  }, [selectedLanguage, t, tldOptionsByLanguage]);

  // Reset TLD when language changes to ensure it's valid for the new language
  useEffect(() => {
    const availableTlds = getTldOptions();
    const currentTldValid = availableTlds.some(option => option.value === tld);

    if (!currentTldValid && availableTlds.length > 0) {
      setTld(availableTlds[0].value); // Set to first available TLD for the language
    }
  }, [getTldOptions, tld, setTld]);

  // Handle language modal
  const openLanguageModal = () => setIsLanguageModalOpen(true);
  const closeLanguageModal = () => setIsLanguageModalOpen(false);

  // Handle language selection
  const handleLanguageSelect = (languageCode) => {
    setIsLanguageModalOpen(false);
    setSelectedLanguage(languageCode);
  };

  // Get selected language details
  const selectedLanguageDetails = languages.find(lang => lang.code === selectedLanguage);

  return (
    <div className="gtts-controls">
      {/* Language Selection */}
      <div className="narration-row gtts-control-row animated-row">
        <div className="row-label">
          <label>{t('narration.gttsLanguage', 'Giọng thuyết minh')}:</label>
        </div>
        <div className="row-content">
          {loading ? (
            <div className="loading-message">
              {t('narration.loadingLanguages', 'Loading languages...')}
            </div>
          ) : (
            <div className="model-dropdown-container narration-model-dropdown-container">
              <button
                className="model-dropdown-btn narration-model-dropdown-btn"
                title={t('narration.selectLanguage', 'Select narration voice')}
                onClick={openLanguageModal}
                disabled={isGenerating || !isServiceAvailable || !inventoryAvailable}
              >
                <span className="model-dropdown-label">{t('narration.voiceLabel', 'Giọng thuyết minh')}:</span>
                <span className="model-dropdown-selected">
                  <span className="model-name">
                    {selectedLanguageDetails ?
                      `${getName(selectedLanguageDetails.code.toLowerCase()) || selectedLanguageDetails.name} (${selectedLanguageDetails.code})` :
                      selectedLanguage || t('narration.selectLanguage', 'Select language')
                    }
                  </span>
                </span>
                <span className="material-symbols-rounded dropdown-icon">expand_more</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Top-Level Domain (Accent) */}
      <div className="narration-row gtts-control-row animated-row">
        <div className="row-label">
          <label htmlFor="gtts-tld">{t('narration.gttsTld', 'Accent/Region')}:</label>
        </div>
        <div className="row-content">
          <CustomDropdown
            value={tld}
            onChange={(value) => handleTldChange({ target: { value } })}
            disabled={isGenerating}
            options={getTldOptions().map(option => ({
              value: option.value,
              label: option.label
            }))}
            placeholder={t('narration.selectAccent', 'Select Accent')}
          />
        </div>
      </div>

      {/* Slow Speech Toggle */}
      <div className="narration-row gtts-control-row animated-row">
        <div className="row-label">
          <label htmlFor="gtts-slow">{t('narration.gttsSlow', 'Slow Speech')}:</label>
        </div>
        <div className="row-content">
          <div className="material-switch-container">
            <MaterialSwitch
              id="gtts-slow"
              checked={slow}
              onChange={handleSlowChange}
              disabled={isGenerating}
              ariaLabel={t('narration.gttsSlowDescription', 'Speak more slowly for better clarity')}
              icons={true}
            />
            <label htmlFor="gtts-slow" className="material-switch-label">
              {t('narration.gttsSlowDescription', 'Speak more slowly for better clarity')}
            </label>
          </div>
        </div>
      </div>

      {/* Language Selection Modal */}
      {isLanguageModalOpen && inventoryAvailable && (
        <LanguageSelectionModal
          isOpen={isLanguageModalOpen}
          onClose={closeLanguageModal}
          languages={languages}
          selectedLanguage={selectedLanguage}
          onLanguageSelect={handleLanguageSelect}
          detectedLanguage={detectedLanguage}
          t={t}
        />
      )}
    </div>
  );
};

export default GTTSControls;
