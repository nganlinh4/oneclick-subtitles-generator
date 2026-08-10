import '../styles/SubtitleCustomizationPanel.css';
import PresetButtons from './subtitleCustomization/PresetButtons';
import TextControls from './subtitleCustomization/TextControls';
import BackgroundControls from './subtitleCustomization/BackgroundControls';
import EffectsControls from './subtitleCustomization/EffectsControls';
import PositionControls from './subtitleCustomization/PositionControls';
import AnimationControls from './subtitleCustomization/AnimationControls';

// defaultCustomization lives in a leaf module to break the panel<->presetDefinitions/controls import cycle.
export { defaultCustomization } from './subtitleCustomization/defaultCustomization';

const SubtitleCustomizationPanel = ({ customization, onChange }) => {
  return (
    <div className="subtitle-customization-panel">
      <div className="panel-content">
        {/* Style Presets */}
        <PresetButtons customization={customization} onChange={onChange} />

        {/* Text Controls */}
        <TextControls customization={customization} onChange={onChange} />

        {/* Background Controls */}
        <BackgroundControls customization={customization} onChange={onChange} />

        {/* Effects Controls */}
        <EffectsControls customization={customization} onChange={onChange} />

        {/* Position Controls */}
        <PositionControls customization={customization} onChange={onChange} />

        {/* Animation Controls */}
        <AnimationControls customization={customization} onChange={onChange} />
      </div>
    </div>
  );
};

export default SubtitleCustomizationPanel;
