import { useTranslation } from 'react-i18next';
import SliderWithValue from '../../common/SliderWithValue';
import HelpIcon from '../../common/HelpIcon';

import '../../../styles/narration/geminiConcurrentClientsSlider.css';

/**
 * Component for controlling parallel Gemini narration requests.
 * @param {Object} props - Component props
 * @param {number} props.concurrentClients - Current number of concurrent clients
 * @param {Function} props.setConcurrentClients - Function to set concurrent clients
 * @param {boolean} props.isGenerating - Whether generation is in progress
 * @returns {JSX.Element} - Rendered component
 */
const GeminiConcurrentClientsSlider = ({
  concurrentClients,
  setConcurrentClients,
  isGenerating
}) => {
  const { t } = useTranslation();

  // The narration state owns and persists the value.
  const handleConcurrentClientsChange = (e) => {
    setConcurrentClients?.(parseInt(e.target.value, 10));
  };

  // No need for percentage calculation - StandardSlider handles this automatically

  return (
    <div className="narration-row gemini-concurrent-clients-row animated-row">
      <div className="row-label">
        <label>{t('narration.concurrentClients', 'Chế độ cực nhanh')}:</label>
      </div>
      <div className="row-content">
        <div className="slider-control-row">
          <SliderWithValue
            value={concurrentClients || 1}
            onChange={(value) => handleConcurrentClientsChange({ target: { value: parseInt(value) } })}
            min={1}
            max={10}
            step={1}
            orientation="Horizontal"
            size="XSmall"
            state={isGenerating ? "Disabled" : "Enabled"}
            className="gemini-concurrent-clients-slider"
            id="gemini-concurrent-clients"
            ariaLabel={t('narration.concurrentClients', 'Chế độ cực nhanh')}
            defaultValue={5}
            formatValue={(v) => `${v}x`}
          >
            <HelpIcon
              title={t('narration.concurrentClientsHelp', 'Mở nhiều hội thoại song song với Gemini cùng lúc, CHÚ Ý: có thể gây cạn kiệt quota nhanh chóng')}
            />
          </SliderWithValue>
        </div>
      </div>
    </div>
  );
};

export default GeminiConcurrentClientsSlider;
