import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveVoiceSample } from '../../../platform/voiceSampleService';
import { GEMINI_VOICES } from '../../../services/gemini/geminiNarrationService';
import '../../../styles/narration/geminiVoiceSelectionCompact.css';
import CustomDropdown from '../../common/CustomDropdown';
import PlayPauseMorphType4 from '../../common/PlayPauseMorphType4';

/**
 * Component for selecting a Gemini voice
 * @param {Object} props - Component props
 * @param {string} props.selectedVoice - Currently selected voice
 * @param {Function} props.setSelectedVoice - Function to set selected voice
 * @param {boolean} props.isGenerating - Whether generation is in progress
 * @returns {JSX.Element} - Rendered component
 */
const GeminiVoiceSelection = ({
  selectedVoice,
  setSelectedVoice,
  isGenerating
}) => {
  const { t } = useTranslation();
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentPlayingVoice, setCurrentPlayingVoice] = useState(null);
  const resolveGeneration = useRef(0);

  // Group voices by gender
  const femaleVoices = GEMINI_VOICES.filter(voice => voice.gender === 'Female');
  const maleVoices = GEMINI_VOICES.filter(voice => voice.gender === 'Male');

  const handleVoiceChange = (newVoice) => {
    setSelectedVoice(newVoice);

    // Store in localStorage for persistence
    try {
      localStorage.setItem('gemini_voice', newVoice);
    } catch (e) {
      console.error('Error storing voice in localStorage:', e);
    }
  };

  const playVoiceSample = async (voiceId) => {
    // If already playing this voice, stop it
    if (isPlaying && currentPlayingVoice === voiceId) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setIsPlaying(false);
      setCurrentPlayingVoice(null);
      resolveGeneration.current += 1;
      return;
    }

    const generation = resolveGeneration.current + 1;
    resolveGeneration.current = generation;

    if (audioRef.current) {
      try {
        const playback = await resolveVoiceSample(voiceId, {
          onProgress: ({ basisPoints }) => window.addToast?.(
            t('narration.installingVoiceSamples', 'Installing voice previews… {{percent}}%', {
              percent: Math.floor(basisPoints / 100),
            }),
            'info',
            5000,
            'voice-samples-install',
          ),
        });
        if (generation !== resolveGeneration.current || !audioRef.current) return;
        window.removeToastByKey?.('voice-samples-install');
        audioRef.current.src = playback.playbackUrl;
        await audioRef.current.play();
        setIsPlaying(true);
        setCurrentPlayingVoice(voiceId);
      } catch (_error) {
        if (generation !== resolveGeneration.current) return;
        window.removeToastByKey?.('voice-samples-install');
        window.addToast?.(
          t('narration.voiceSampleUnavailable', 'Voice preview is unavailable. Please try again.'),
          'error',
          6000,
          'voice-samples-install',
        );
        setIsPlaying(false);
        setCurrentPlayingVoice(null);
      }
    }
  };

  // Handle audio ended event
  useEffect(() => {
    const handleAudioEnded = () => {
      setIsPlaying(false);
      setCurrentPlayingVoice(null);
    };

    if (audioRef.current) {
      const audio = audioRef.current; // Store reference to avoid closure issues
      audio.addEventListener('ended', handleAudioEnded);

      return () => {
        audio.removeEventListener('ended', handleAudioEnded);
      };
    }
  }, []);

  // Get the currently selected voice object
  const selectedVoiceObj = GEMINI_VOICES.find(voice => voice.id === selectedVoice) || GEMINI_VOICES[0];

  // Get the gender of the currently selected voice
  const selectedGender = selectedVoiceObj?.gender || 'Female';

  // Filter voices by the selected gender
  const filteredVoices = GEMINI_VOICES.filter(voice => voice.gender === selectedGender);

  return (
    <div className="narration-row gemini-voice-row animated-row">
      <div className="row-label">
        <label>{t('narration.voice', 'Voice')}:</label>
      </div>
      <div className="row-content">
        <div className="gemini-voice-selection">
          {/* Hidden audio element for playing voice samples */}
          <audio ref={audioRef} className="voice-sample-audio" />

          <div className="voice-dropdown-container">
            {/* Voice type selection pills */}
            <div className="voice-type-pills">
              <div className={`voice-type-pill female`}>
                <input
                  type="radio"
                  id="voice-type-female"
                  name="voice-type"
                  value="Female"
                  checked={selectedGender === 'Female'}
                  onChange={() => {
                    // Find the first female voice and select it
                    const firstFemaleVoice = femaleVoices[0];
                    if (firstFemaleVoice) {
                      setSelectedVoice(firstFemaleVoice.id);
                      localStorage.setItem('gemini_voice', firstFemaleVoice.id);
                    }
                  }}
                  disabled={isGenerating}
                />
                <label htmlFor="voice-type-female">
                  {t('narration.femaleVoices', 'Female Voices')}
                </label>
              </div>

              <div className={`voice-type-pill male`}>
                <input
                  type="radio"
                  id="voice-type-male"
                  name="voice-type"
                  value="Male"
                  checked={selectedGender === 'Male'}
                  onChange={() => {
                    // Find the first male voice and select it
                    const firstMaleVoice = maleVoices[0];
                    if (firstMaleVoice) {
                      setSelectedVoice(firstMaleVoice.id);
                      localStorage.setItem('gemini_voice', firstMaleVoice.id);
                    }
                  }}
                  disabled={isGenerating}
                />
                <label htmlFor="voice-type-male">
                  {t('narration.maleVoices', 'Male Voices')}
                </label>
              </div>
            </div>

            {/* Voice dropdown */}
            <div className="voice-dropdown">
              <CustomDropdown
                value={selectedVoice}
                onChange={handleVoiceChange}
                disabled={isGenerating}
                options={filteredVoices.map(voice => ({
                  value: voice.id,
                  label: voice.name
                }))}
                placeholder={t('narration.selectVoice', 'Select Voice')}
              />
            </div>

            {/* Play button */}
            <button
              type="button"
              className={`play-voice-sample ${isPlaying && currentPlayingVoice === selectedVoice ? 'playing' : ''}`}
              onClick={(e) => {
                e.preventDefault();
                playVoiceSample(selectedVoice);
              }}
              title={t('narration.playVoiceSample', 'Play voice sample')}
              disabled={isGenerating}
            >
              <PlayPauseMorphType4 playing={isPlaying && currentPlayingVoice === selectedVoice} size={16} color="currentColor" config={{ rotateDegrees: 0 }} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GeminiVoiceSelection;
