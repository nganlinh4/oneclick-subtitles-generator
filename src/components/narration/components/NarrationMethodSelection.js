import React from 'react';
import { useTranslation } from 'react-i18next';
import '../../../styles/narration/narrationMethodSelectionMaterial.css';
import HelpIcon from '../../common/HelpIcon';


/**
 * Component for selecting the narration method (F5-TTS, Chatterbox, Gemini, Edge TTS, or gTTS)
 * @param {Object} props - Component props
 * @param {string} props.narrationMethod - Current narration method
 * @param {Function} props.setNarrationMethod - Function to set narration method
 * @param {boolean} props.isGenerating - Whether generation is in progress
 * @param {boolean} props.isF5Available - Whether F5-TTS is available
 * @param {boolean} props.isChatterboxAvailable - Whether Chatterbox is available
 * @param {boolean} props.isGeminiAvailable - Whether Gemini is available
 * @param {boolean} props.isEdgeTTSAvailable - Whether Edge TTS is available
 * @param {boolean} props.isGTTSAvailable - Whether gTTS is available
 * @returns {JSX.Element} - Rendered component
 */
const NarrationMethodSelection = ({
  narrationMethod,
  setNarrationMethod,
  isGenerating,
  isF5Available = true,
  isChatterboxAvailable = true,
  isGeminiAvailable = true,
  isEdgeTTSAvailable = true,
  isGTTSAvailable = true
}) => {
  const { t } = useTranslation();

  const handleMethodChange = (method) => {
    if (!isGenerating) {
      setNarrationMethod(method);
      // Save to localStorage for persistence
      localStorage.setItem('narration_method', method);
    }
  };

  return (
    <div className="narration-row narration-method-row">
      <div className="row-label">
        <label>{t('narration.narrationMethod', 'Narration Method')}:</label>
      </div>
      <div className="row-content">
        <div className="narration-method-selection">
          <div className="radio-pill-group">
            <div className="radio-pill">
              <input
                type="radio"
                id="method-f5tts"
                name="narration-method"
                value="f5tts"
                checked={narrationMethod === 'f5tts'}
                onChange={() => handleMethodChange('f5tts')}
                disabled={isGenerating || !isF5Available}
              />
              <label htmlFor="method-f5tts" className={`method-f5tts ${!isF5Available ? 'unavailable' : ''}`}>
                <span className="voice-clone-badge">Voice Clone</span>
                <span className="method-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 0 24 24" width="16px" fill="currentColor">
                    <path d="M0 0h24v24H0V0z" fill="none"/>
                    <path d="M8 18c.55 0 1-.45 1-1V7c0-.55-.45-1-1-1s-1 .45-1 1v10c0 .55.45 1 1 1zm4 4c.55 0 1-.45 1-1V3c0-.55-.45-1-1-1s-1 .45-1 1v18c0 .55.45 1 1 1zm-8-8c.55 0 1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1v2c0 .55.45 1 1 1zm12 4c.55 0 1-.45 1-1V7c0-.55-.45-1-1-1s-1 .45-1 1v10c0 .55.45 1 1 1zm3-7v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1z"/>
                  </svg>
                </span>
                {t('narration.f5ttsMethod', 'F5-TTS')}
                {!isF5Available && (
                  <HelpIcon className="method-help-icon" title={t('narration.f5ttsUnavailable', '(Unavailable - Run with npm run dev:cuda)')} />
                )}
              </label>
            </div>
            <div className="radio-pill">
              <input
                type="radio"
                id="method-chatterbox"
                name="narration-method"
                value="chatterbox"
                checked={narrationMethod === 'chatterbox'}
                onChange={() => handleMethodChange('chatterbox')}
                disabled={isGenerating || !isChatterboxAvailable}
              />
              <label htmlFor="method-chatterbox" className={`method-chatterbox ${!isChatterboxAvailable ? 'unavailable' : ''}`}>
                <span className="voice-clone-badge">Voice Clone</span>
                <span className="method-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 97 113">
                    <path d="M97 49c14-20 2-47-22-49-14 0-36 0-42 2C16 8 0 26 0 49v62c0 2 2 2 3 2l15-9 4-1h53c7-1 14-4 19-9 4-3 7-8 8-13 3-11 0-21-7-29l2-3ZM52 62h19s14-1 14 11c0 13-14 11-14 11H52a33 33 0 0 1 0-66h19s14 0 14 12-14 11-14 11H52a10 10 0 0 0 0 21Z"/>
                  </svg>
                </span>
                {t('narration.chatterboxMethod', 'Chatterbox')}
                {!isChatterboxAvailable && (
                  <HelpIcon className="method-help-icon" title={t('narration.chatterboxUnavailable', '(Unavailable - Run with npm run dev:cuda)')} />
                )}
              </label>
            </div>
            <div className="radio-pill">
              <input
                type="radio"
                id="method-gemini"
                name="narration-method"
                value="gemini"
                checked={narrationMethod === 'gemini'}
                onChange={() => handleMethodChange('gemini')}
                disabled={isGenerating || !isGeminiAvailable}
              />
              <label htmlFor="method-gemini" className={`method-gemini ${!isGeminiAvailable ? 'unavailable' : ''}`}>
                <span className="method-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" enableBackground="new 0 0 24 24" height="16px" viewBox="0 0 24 24" width="16px" fill="currentColor">
                    <g><rect fill="none" height="24" width="24"/><rect fill="none" height="24" width="24"/></g>
                    <g><g><path d="M21,12.22C21,6.73,16.74,3,12,3c-4.69,0-9,3.65-9,9.28C2.4,12.62,2,13.26,2,14v2c0,1.1,0.9,2,2,2h0c0.55,0,1-0.45,1-1 l0-4.81c0-3.83,2.95-7.18,6.78-7.29c3.96-0.12,7.22,3.06,7.22,7V19h-7c-0.55,0-1,0.45-1,1v0c0,0.55,0.45,1,1,1h7c1.1,0,2-0.9,2-2 v-1.22c0.59-0.31,1-0.92,1-1.64v-2.3C22,13.14,21.59,12.53,21,12.22z"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M18,11.03C17.52,8.18,15.04,6,12.05,6c-3.03,0-6.29,2.51-6.03,6.45c2.47-1.01,4.33-3.21,4.86-5.89 C12.19,9.19,14.88,11,18,11.03z"/></g></g>
                  </svg>
                </span>
                {t('narration.geminiMethod', 'Gemini Live API')}
                {!isGeminiAvailable && (
                  <HelpIcon className="method-help-icon" title={t('narration.geminiUnavailable', '(Unavailable - Check API key in settings)')} />
                )}
              </label>
            </div>
            <div className="radio-pill">
              <input
                type="radio"
                id="method-edge-tts"
                name="narration-method"
                value="edge-tts"
                checked={narrationMethod === 'edge-tts'}
                onChange={() => handleMethodChange('edge-tts')}
                disabled={isGenerating || !isEdgeTTSAvailable}
              />
              <label htmlFor="method-edge-tts" className={`method-edge-tts ${!isEdgeTTSAvailable ? 'unavailable' : ''}`}>
                <span className="method-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M21.86 17.86q.14 0 .25.12.1.13.1.25t-.11.33l-.32.46-.43.53-.44.5q-.21.25-.38.42l-.22.23q-.58.53-1.34 1.04-.76.51-1.6.91-.86.4-1.74.64t-1.67.24q-.9 0-1.69-.28-.8-.28-1.48-.78-.68-.5-1.22-1.17-.53-.66-.92-1.44-.38-.77-.58-1.6-.2-.83-.2-1.67q0-1 .32-1.96.33-.97.87-1.8.14.95.55 1.77.41.82 1.02 1.5.6.68 1.38 1.21.78.54 1.64.9.86.36 1.77.56.92.2 1.8.2 1.12 0 2.18-.24 1.06-.23 2.06-.72l.2-.1.2-.05zm-15.5-1.27q0 1.1.27 2.15.27 1.06.78 2.03.51.96 1.24 1.77.74.82 1.66 1.4-1.47-.2-2.8-.74-1.33-.55-2.48-1.37-1.15-.83-2.08-1.9-.92-1.07-1.58-2.33T.36 14.94Q0 13.54 0 12.06q0-.81.32-1.49.31-.68.83-1.23.53-.55 1.2-.96.66-.4 1.35-.66.74-.27 1.5-.39.78-.12 1.55-.12.7 0 1.42.1.72.12 1.4.35.68.23 1.32.57.63.35 1.16.83-.35 0-.7.07-.33.07-.65.23v-.02q-.63.28-1.2.74-.57.46-1.05 1.04-.48.58-.87 1.26-.38.67-.65 1.39-.27.71-.42 1.44-.15.72-.15 1.38zM11.96.06q1.7 0 3.33.39 1.63.38 3.07 1.15 1.43.77 2.62 1.93 1.18 1.16 1.98 2.7.49.94.76 1.96.28 1 .28 2.08 0 .89-.23 1.7-.24.8-.69 1.48-.45.68-1.1 1.22-.64.53-1.45.88-.54.24-1.11.36-.58.13-1.16.13-.42 0-.97-.03-.54-.03-1.1-.12-.55-.1-1.05-.28-.5-.19-.84-.5-.12-.09-.23-.24-.1-.16-.1-.33 0-.15.16-.35.16-.2.35-.5.2-.28.36-.68.16-.4.16-.95 0-1.06-.4-1.96-.4-.91-1.06-1.64-.66-.74-1.52-1.28-.86-.55-1.79-.89-.84-.3-1.72-.44-.87-.14-1.76-.14-1.55 0-3.06.45T.94 7.55q.71-1.74 1.81-3.13 1.1-1.38 2.52-2.35Q6.68 1.1 8.37.58q1.7-.52 3.58-.52Z"/>
                  </svg>
                </span>
                {t('narration.edgeTTSMethod', 'Edge TTS')}
                {!isEdgeTTSAvailable && (
                  <HelpIcon className="method-help-icon" title={t('narration.edgeTTSUnavailable', '(Unavailable)')} />
                )}
              </label>
            </div>
            <div className="radio-pill">
              <input
                type="radio"
                id="method-gtts"
                name="narration-method"
                value="gtts"
                checked={narrationMethod === 'gtts'}
                onChange={() => handleMethodChange('gtts')}
                disabled={isGenerating || !isGTTSAvailable}
              />
              <label htmlFor="method-gtts" className={`method-gtts ${!isGTTSAvailable ? 'unavailable' : ''}`}>
                <span className="method-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
                    <path fill="none" d="M0 0h24v24H0V0z"/>
                    <path d="M20 5h-9.12L10 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2h7l1 3h8a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zM7.17 14.59a4.1 4.1 0 0 1 0-8.18c1.04 0 1.99.37 2.74 1.07l.07.06-1.23 1.18-.06-.05a2.17 2.17 0 0 0-1.52-.59c-1.31 0-2.38 1.09-2.38 2.42s1.07 2.42 2.38 2.42c1.37 0 1.96-.87 2.12-1.46H7.08V9.91h3.95l.01.07c.04.21.05.4.05.61 0 2.35-1.61 4-3.92 4zm6.03-1.71c.33.6.74 1.18 1.19 1.7l-.54.53-.65-2.23zm.77-.76h-.99l-.31-1.04h3.99s-.34 1.31-1.56 2.74a9.18 9.18 0 0 1-1.13-1.7zM21 20a1 1 0 0 1-1 1h-7l2-2-.81-2.77.92-.92L17.79 18l.73-.73-2.71-2.68a8.73 8.73 0 0 0 1.92-3.51H19v-1.04h-3.64V9h-1.04v1.04h-1.96L11.18 6H20a1 1 0 0 1 1 1v13z"/>
                  </svg>
                </span>
                {t('narration.gttsMethod', 'gTTS')}
                {!isGTTSAvailable && (
                  <HelpIcon className="method-help-icon" title={t('narration.gttsUnavailable', '(Unavailable)')} />
                )}
              </label>
            </div>
            <div className="radio-pill">
              <input
                type="radio"
                id="method-ms-vibevoice"
                name="narration-method"
                value="ms-vibevoice"
                checked={false}
                onChange={() => {}}
                disabled={true}
              />
              <label htmlFor="method-ms-vibevoice" className="method-ms-vibevoice unavailable">
                <span className="voice-clone-badge">Voice Clone</span>
                <span className="method-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
                    <path d="M560-690q0-25-20.5-44.5T492-754q-18 0-36 7t-33 19q-29 29-64 35t-61-11q-29-19-33-50.5t20-61.5q36-48 90-72.5T492-913q100 0 165 63.5T722-690q0 50-28.5 105.5T614-478q-5 5-15 18.5T579-434q-19 31-41 45.5T493-374q-33 0-55-20t-22-47q0-44 24-87t63-68q28-16 42.5-39.5T560-690ZM492-96q-47 0-79.5-32.5T380-208q0-47 32.5-80t79.5-33q47 0 80 33t33 80q0 47-33 79.5T492-96Z"/>
                  </svg>
                </span>
                {t('narration.msVibeVoiceMethod', 'MS VibeVoice')} ({t('narration.comingSoon', 'coming soon')})
              </label>
            </div>
            <div className="radio-pill">
              <input
                type="radio"
                id="method-gemini-native"
                name="narration-method"
                value="gemini-native"
                checked={false}
                onChange={() => {}}
                disabled={true}
              />
              <label htmlFor="method-gemini-native" className="method-gemini-native unavailable">
                <span className="method-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
                    <path d="M560-690q0-25-20.5-44.5T492-754q-18 0-36 7t-33 19q-29 29-64 35t-61-11q-29-19-33-50.5t20-61.5q36-48 90-72.5T492-913q100 0 165 63.5T722-690q0 50-28.5 105.5T614-478q-5 5-15 18.5T579-434q-19 31-41 45.5T493-374q-33 0-55-20t-22-47q0-44 24-87t63-68q28-16 42.5-39.5T560-690ZM492-96q-47 0-79.5-32.5T380-208q0-47 32.5-80t79.5-33q47 0 80 33t33 80q0 47-33 79.5T492-96Z"/>
                  </svg>
                </span>
                {t('narration.geminiNativeDialogMethod', 'Gemini Native Dialog')} ({t('narration.comingSoon', 'coming soon')})
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NarrationMethodSelection;
