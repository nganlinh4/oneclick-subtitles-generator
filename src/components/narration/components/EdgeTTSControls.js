import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getSpeechLifecycleSnapshot,
  getSpeechVoiceInventory,
  subscribeSpeechLifecycle,
} from '../../../platform/speechService';
import SliderWithValue from '../../common/SliderWithValue';
import VoiceSelectionModal from './VoiceSelectionModal';
import '../../../styles/narration/narrationAdvancedSettingsRedesign.css';
import '../../../styles/narration/narrationModelDropdown.css';

/**
 * Edge TTS Controls component for voice selection and speech parameters
 * @param {Object} props - Component props
 * @param {string} props.selectedVoice - Currently selected voice
 * @param {Function} props.setSelectedVoice - Function to set selected voice
 * @param {string} props.rate - Current speech rate
 * @param {Function} props.setRate - Function to set speech rate
 * @param {string} props.volume - Current speech volume
 * @param {Function} props.setVolume - Function to set speech volume
 * @param {string} props.pitch - Current speech pitch
 * @param {Function} props.setPitch - Function to set speech pitch
 * @param {boolean} props.isGenerating - Whether generation is in progress
 * @param {Object} props.detectedLanguage - Detected language from subtitles
 * @returns {JSX.Element} - Rendered component
 */
const EdgeTTSControls = ({
  selectedVoice,
  setSelectedVoice,
  rate,
  setRate,
  volume,
  setVolume,
  pitch,
  setPitch,
  isGenerating,
  detectedLanguage,
  isServiceAvailable = false
}) => {
  const { t } = useTranslation();
  const [voices, setVoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inventoryAvailable, setInventoryAvailable] = useState(false);
  const [lifecycle, setLifecycle] = useState(() => getSpeechLifecycleSnapshot('edgeTts'));
  const [isVoiceModalOpen, setIsVoiceModalOpen] = useState(false);
  const voiceRequestSequence = useRef(0);

  useEffect(() => subscribeSpeechLifecycle((snapshot) => {
    if (snapshot.backend === 'edgeTts') setLifecycle(snapshot);
  }), []);

  // Voice inventory is requested only for an already-running engine. Tools owns Start/Stop.
  useEffect(() => {
    const sequence = voiceRequestSequence.current + 1;
    voiceRequestSequence.current = sequence;
    if (!isServiceAvailable
        || !lifecycle?.enabled
        || !lifecycle.warm) {
      setVoices([]);
      setInventoryAvailable(false);
      setLoading(false);
      return () => { voiceRequestSequence.current += 1; };
    }
    const loadVoices = async () => {
      try {
        setLoading(true);
        const inventory = await getSpeechVoiceInventory('edgeTts', lifecycle.epoch);
        if (voiceRequestSequence.current !== sequence) return;
        const currentLifecycle = getSpeechLifecycleSnapshot('edgeTts');
        if (!currentLifecycle?.enabled
            || !currentLifecycle.warm
            || currentLifecycle.epoch !== inventory.epoch) return;
        const data = {
          voices: inventory.voices.map((voice) => ({
            short_name: voice.id,
            display_name: voice.displayName,
            language: voice.language.split('-')[0],
            locale: voice.language,
            gender: voice.gender,
          })),
        };
        setVoices(data.voices || []);
        setInventoryAvailable(data.voices.length > 0);
      } catch (err) {
        if (voiceRequestSequence.current !== sequence) return;
        setVoices([]);
        setInventoryAvailable(false);
        console.error('Error loading Edge TTS voices:', err);
        window.addToast('Failed to load voices', 'error', 5000);
      } finally {
        if (voiceRequestSequence.current === sequence) setLoading(false);
      }
    };

    loadVoices();
    return () => {
      if (voiceRequestSequence.current === sequence) voiceRequestSequence.current += 1;
    };
  }, [isServiceAvailable, lifecycle?.enabled, lifecycle?.epoch, lifecycle?.warm]);

  useEffect(() => {
    if (!isServiceAvailable || !inventoryAvailable || selectedVoice || voices.length === 0) return;
    const matchingVoice = detectedLanguage?.languageCode
      ? voices.find((voice) => (
        voice.language === detectedLanguage.languageCode
        || voice.locale.startsWith(`${detectedLanguage.languageCode}-`)
      ))
      : null;
    setSelectedVoice((matchingVoice || voices[0]).short_name);
  }, [
    detectedLanguage,
    inventoryAvailable,
    isServiceAvailable,
    selectedVoice,
    setSelectedVoice,
    voices,
  ]);

  // Handle voice modal
  const openVoiceModal = () => setIsVoiceModalOpen(true);
  const closeVoiceModal = () => setIsVoiceModalOpen(false);

  // Handle voice selection
  const handleVoiceSelect = (voiceName) => {
    setIsVoiceModalOpen(false);
    setSelectedVoice(voiceName);
  };

  // Get selected voice details (selectedVoice now contains short_name)
  const selectedVoiceDetails = voices.find(voice => voice.short_name === selectedVoice);

  return (
    <div className="edge-tts-controls">
      {/* Voice Selection */}
      <div className="narration-row edge-tts-control-row animated-row">
        <div className="row-label">
          <label>{t('narration.edgeTTSVoice', 'Giọng thuyết minh')}:</label>
        </div>
        <div className="row-content">
          {loading ? (
            <div className="loading-message">
              {t('narration.loadingVoices', 'Loading voices...')}
            </div>
          ) : (
            <div className="model-dropdown-container narration-model-dropdown-container">
              <button
                className="model-dropdown-btn narration-model-dropdown-btn"
                title={t('narration.selectVoice', 'Select narration voice')}
                onClick={openVoiceModal}
                disabled={isGenerating || !isServiceAvailable || !inventoryAvailable}
              >
                {/* Badge: show when selected voice language differs from detected language */}
                {(detectedLanguage?.languageCode && selectedVoiceDetails &&
                  !(selectedVoiceDetails.language === detectedLanguage.languageCode ||
                    (selectedVoiceDetails.locale || '').startsWith(detectedLanguage.languageCode + '-'))
                ) && (
                    <span
                      className="tab-badge"
                      role="status"
                      aria-label={t('narration.mismatchBadge', 'Selected voice language differs from detected language')}
                      title={t('narration.mismatchBadge', 'Selected voice language differs from detected language')}
                    />
                  )}
                <span className="model-dropdown-label">{t('narration.voiceLabel', 'Giọng thuyết minh')}:</span>
                <span className="model-dropdown-selected">
                  <span className="model-name">
                    {selectedVoiceDetails ?
                      selectedVoiceDetails.display_name :
                      selectedVoice || t('narration.selectVoice', 'Select voice')
                    }
                  </span>
                </span>
                <span className="material-symbols-rounded dropdown-icon">expand_more</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Speech Rate */}
      <div className="narration-row edge-tts-control-row animated-row">
        <div className="row-label">
          <label htmlFor="edge-tts-rate">{t('narration.edgeTTSRate', 'Speech Rate')}:</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={parseInt(rate.replace('%', ''))}
            onChange={(value) => setRate(`${value >= 0 ? '+' : ''}${value}%`)}
            min={-50}
            max={50}
            step={5}
            orientation="Horizontal"
            size="XSmall"
            state={isGenerating ? "Disabled" : "Enabled"}
            className="edge-tts-rate-slider"
            id="edge-tts-rate"
            ariaLabel={t('narration.edgeTTSRate', 'Speech Rate')}
            formatValue={(v) => `${v >= 0 ? '+' : ''}${v}%`}
          />
        </div>
      </div>

      {/* Speech Volume */}
      <div className="narration-row edge-tts-control-row animated-row">
        <div className="row-label">
          <label htmlFor="edge-tts-volume">{t('narration.edgeTTSVolume', 'Volume')}:</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={parseInt(volume.replace('%', ''))}
            onChange={(value) => setVolume(`${value >= 0 ? '+' : ''}${value}%`)}
            min={-50}
            max={50}
            step={5}
            orientation="Horizontal"
            size="XSmall"
            state={isGenerating ? "Disabled" : "Enabled"}
            className="edge-tts-volume-slider"
            id="edge-tts-volume"
            ariaLabel={t('narration.edgeTTSVolume', 'Volume')}
            formatValue={(v) => `${v >= 0 ? '+' : ''}${v}%`}
          />
        </div>
      </div>

      {/* Speech Pitch */}
      <div className="narration-row edge-tts-control-row animated-row">
        <div className="row-label">
          <label htmlFor="edge-tts-pitch">{t('narration.edgeTTSPitch', 'Pitch')}:</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={parseInt(pitch.replace('Hz', ''))}
            onChange={(value) => setPitch(`${value >= 0 ? '+' : ''}${value}Hz`)}
            min={-50}
            max={50}
            step={5}
            orientation="Horizontal"
            size="XSmall"
            state={isGenerating ? "Disabled" : "Enabled"}
            className="edge-tts-pitch-slider"
            id="edge-tts-pitch"
            ariaLabel={t('narration.edgeTTSPitch', 'Pitch')}
            formatValue={(v) => `${v >= 0 ? '+' : ''}${v}Hz`}
          />
        </div>
      </div>



      {/* Voice Selection Modal */}
      {isVoiceModalOpen && inventoryAvailable && (
        <VoiceSelectionModal
          isOpen={isVoiceModalOpen}
          onClose={closeVoiceModal}
          voices={voices}
          selectedVoice={selectedVoice}
          onVoiceSelect={handleVoiceSelect}
          detectedLanguage={detectedLanguage}
          t={t}
        />
      )}
    </div>
  );
};

export default EdgeTTSControls;
