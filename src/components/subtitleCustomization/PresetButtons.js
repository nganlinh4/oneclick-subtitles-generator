import React, { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { defaultCustomization } from '../SubtitleCustomizationPanel';
import { getCustomSubtitlePresets, deleteCustomSubtitlePreset, hasCustomizationChanged, addCustomSubtitlePreset } from '../../utils/subtitlePresetUtils';
import PresetNamingModal from './PresetNamingModal';

const PresetButtons = ({ customization, onChange }) => {
  const { t } = useTranslation();
  const [customPresets, setCustomPresets] = useState([]);
  const [showNamingModal, setShowNamingModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setCustomPresets(getCustomSubtitlePresets());
  }, []);

  const presets = {
      default: defaultCustomization,
      modern: {
        // Text properties
        fontSize: 32,
        fontFamily: "'Roboto', sans-serif",
        fontWeight: 400,
        textColor: '#ffffff',
        textAlign: 'center',
        lineHeight: 1.2,
        letterSpacing: 0,
        textTransform: 'none',

        // Background properties
        backgroundColor: '#1a1a1a',
        backgroundOpacity: 80,
        borderRadius: 8,
        borderWidth: 0,
        borderColor: '#ffffff',
        borderStyle: 'none',

        // Shadow and effects
        textShadowEnabled: false,
        textShadowColor: '#000000',
        textShadowBlur: 4,
        textShadowOffsetX: 0,
        textShadowOffsetY: 2,
        glowEnabled: false,
        glowColor: '#ffffff',
        glowIntensity: 10,

        // Gradient effects
        gradientEnabled: false,
        gradientType: 'linear',
        gradientDirection: '45deg',
        gradientColorStart: '#ffffff',
        gradientColorEnd: '#cccccc',
        gradientColorMid: '#eeeeee',

        // Advanced text effects
        strokeEnabled: false,
        strokeWidth: 2,
        strokeColor: '#000000',
        multiShadowEnabled: false,
        shadowLayers: 1,

        // Kinetic effects
        pulseEnabled: false,
        pulseSpeed: 1,
        shakeEnabled: false,
        shakeIntensity: 2,

        // Position
        position: 'bottom',
        customPositionX: 50,
        customPositionY: 80,
        marginBottom: 80,
        marginTop: 80,
        marginLeft: 0,
        marginRight: 0,
        maxWidth: 80,

        // Animation
        fadeInDuration: 0.3,
        fadeOutDuration: 0.3,
        animationType: 'fade',
        animationEasing: 'ease',

        // Text wrapping
        wordWrap: true,
        maxLines: 3,
        lineBreakBehavior: 'auto',
        rtlSupport: false,

        preset: 'modern'
      },
      classic: {
        // Text properties
        fontSize: 30,
        fontFamily: "'Times New Roman', serif",
        fontWeight: 700,
        textColor: '#ffff00',
        textAlign: 'center',
        lineHeight: 1.2,
        letterSpacing: 0,
        textTransform: 'none',

        // Background properties
        backgroundColor: '#000000',
        backgroundOpacity: 70,
        borderRadius: 0,
        borderWidth: 0,
        borderColor: '#ffffff',
        borderStyle: 'none',

        // Shadow and effects
        textShadowEnabled: true,
        textShadowColor: '#000000',
        textShadowBlur: 6,
        textShadowOffsetX: 0,
        textShadowOffsetY: 2,
        glowEnabled: false,
        glowColor: '#ffffff',
        glowIntensity: 10,

        // Gradient effects
        gradientEnabled: false,
        gradientType: 'linear',
        gradientDirection: '45deg',
        gradientColorStart: '#ffffff',
        gradientColorEnd: '#cccccc',
        gradientColorMid: '#eeeeee',

        // Advanced text effects
        strokeEnabled: false,
        strokeWidth: 2,
        strokeColor: '#000000',
        multiShadowEnabled: false,
        shadowLayers: 1,

        // Kinetic effects
        pulseEnabled: false,
        pulseSpeed: 1,
        shakeEnabled: false,
        shakeIntensity: 2,

        // Position
        position: 'bottom',
        customPositionX: 50,
        customPositionY: 80,
        marginBottom: 80,
        marginTop: 80,
        marginLeft: 0,
        marginRight: 0,
        maxWidth: 80,

        // Animation
        fadeInDuration: 0.3,
        fadeOutDuration: 0.3,
        animationType: 'fade',
        animationEasing: 'ease',

        // Text wrapping
        wordWrap: true,
        maxLines: 3,
        lineBreakBehavior: 'auto',
        rtlSupport: false,

        preset: 'classic'
      },
      neon: {
        // Text properties
        fontSize: 34,
        fontFamily: "'Arial', sans-serif",
        fontWeight: 700,
        textColor: '#00ffff',
        textAlign: 'center',
        lineHeight: 1.2,
        letterSpacing: 0,
        textTransform: 'none',

        // Background properties
        backgroundColor: '#000000',
        backgroundOpacity: 90,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: '#00ffff',
        borderStyle: 'solid',

        // Shadow and effects
        textShadowEnabled: true,
        textShadowColor: '#000000',
        textShadowBlur: 4,
        textShadowOffsetX: 0,
        textShadowOffsetY: 2,
        glowEnabled: true,
        glowColor: '#00ffff',
        glowIntensity: 15,

        // Gradient effects
        gradientEnabled: false,
        gradientType: 'linear',
        gradientDirection: '45deg',
        gradientColorStart: '#ffffff',
        gradientColorEnd: '#cccccc',
        gradientColorMid: '#eeeeee',

        // Advanced text effects
        strokeEnabled: false,
        strokeWidth: 2,
        strokeColor: '#000000',
        multiShadowEnabled: false,
        shadowLayers: 1,

        // Kinetic effects
        pulseEnabled: false,
        pulseSpeed: 1,
        shakeEnabled: false,
        shakeIntensity: 2,

        // Position
        position: 'bottom',
        customPositionX: 50,
        customPositionY: 80,
        marginBottom: 80,
        marginTop: 80,
        marginLeft: 0,
        marginRight: 0,
        maxWidth: 80,

        // Animation
        fadeInDuration: 0.3,
        fadeOutDuration: 0.3,
        animationType: 'fade',
        animationEasing: 'ease',

        // Text wrapping
        wordWrap: true,
        maxLines: 3,
        lineBreakBehavior: 'auto',
        rtlSupport: false,

        preset: 'neon'
      },
      minimal: {
        ...defaultCustomization,
        fontFamily: "'Helvetica', sans-serif",
        fontSize: 26,
        fontWeight: 300,
        backgroundColor: 'transparent',
        backgroundOpacity: 0,
        borderRadius: 0,
        textShadowEnabled: true,
        textShadowColor: '#000000',
        textShadowBlur: 8,
        strokeEnabled: false,
        preset: 'minimal'
      },
      gaming: {
        ...defaultCustomization,
        fontFamily: "'Audiowide', cursive",
        fontSize: 36,
        fontWeight: 700,
        textColor: '#ff6b35',
        backgroundColor: '#0a0a0a',
        backgroundOpacity: 85,
        borderRadius: 6,
        borderWidth: 2,
        borderColor: '#ff6b35',
        borderStyle: 'solid',
        glowEnabled: true,
        glowColor: '#ff6b35',
        glowIntensity: 12,
        strokeEnabled: true,
        strokeWidth: 1,
        strokeColor: '#000000',
        animationType: 'bounce',
        preset: 'gaming'
      },
      cinematic: {
        ...defaultCustomization,
        fontFamily: "'Playfair Display', serif",
        fontSize: 32,
        fontWeight: 400,
        textColor: '#f5f5dc',
        backgroundColor: '#1c1c1c',
        backgroundOpacity: 75,
        borderRadius: 2,
        textShadowEnabled: true,
        textShadowColor: '#000000',
        textShadowBlur: 8,
        textShadowOffsetY: 3,
        letterSpacing: 1,
        lineHeight: 1.4,
        strokeEnabled: false,
        preset: 'cinematic'
      },
      gradient: {
        ...defaultCustomization,
        fontFamily: "'Montserrat', sans-serif",
        fontSize: 34,
        fontWeight: 600,
        gradientEnabled: true,
        gradientType: 'linear',
        gradientDirection: '45deg',
        gradientColorStart: '#ff6b6b',
        gradientColorEnd: '#4ecdc4',
        backgroundColor: '#000000',
        backgroundOpacity: 60,
        borderRadius: 8,
        textShadowEnabled: true,
        textShadowColor: '#000000',
        textShadowBlur: 6,
        strokeEnabled: false,
        preset: 'gradient'
      },
      retro: {
        ...defaultCustomization,
        fontFamily: "'Press Start 2P', cursive",
        fontSize: 24,
        fontWeight: 700,
        textColor: '#00ff41',
        backgroundColor: '#000000',
        backgroundOpacity: 90,
        borderRadius: 0,
        textShadowEnabled: true,
        textShadowColor: '#00ff41',
        textShadowBlur: 10,
        glowEnabled: true,
        glowColor: '#00ff41',
        glowIntensity: 8,
        letterSpacing: 2,
        textTransform: 'uppercase',
        strokeEnabled: false,
        preset: 'retro'
      },
      elegant: {
        ...defaultCustomization,
        fontFamily: "'Cormorant Garamond', serif",
        fontSize: 30,
        fontWeight: 300,
        textColor: '#ffffff',
        backgroundColor: 'transparent',
        backgroundOpacity: 0,
        borderRadius: 0,
        textShadowEnabled: true,
        textShadowColor: '#000000',
        textShadowBlur: 12,
        textShadowOffsetY: 2,
        letterSpacing: 0.5,
        lineHeight: 1.5,
        strokeEnabled: true,
        strokeWidth: 1,
        strokeColor: '#333333',
        preset: 'elegant'
      },
      cyberpunk: {
        ...defaultCustomization,
        fontFamily: "'Orbitron', sans-serif",
        fontSize: 38,
        fontWeight: 700,
        textColor: '#ff0080',
        backgroundColor: '#000000',
        backgroundOpacity: 95,
        borderRadius: 0,
        borderWidth: 3,
        borderColor: '#ff0080',
        glowEnabled: true,
        glowColor: '#ff0080',
        glowIntensity: 25,
        textShadowEnabled: true,
        textShadowColor: '#ff0080',
        textShadowBlur: 15,
        letterSpacing: 3,
        textTransform: 'uppercase',
        strokeEnabled: false,
        preset: 'cyberpunk'
      },
      vintage: {
        ...defaultCustomization,
        fontFamily: "'Playfair Display', serif",
        fontSize: 32,
        fontWeight: 400,
        textColor: '#f4e4bc',
        backgroundColor: '#8b4513',
        backgroundOpacity: 85,
        borderRadius: 15,
        borderWidth: 2,
        borderColor: '#daa520',
        textShadowEnabled: true,
        textShadowColor: '#654321',
        textShadowBlur: 8,
        letterSpacing: 1,
        strokeEnabled: false,
        preset: 'vintage'
      },
      comic: {
        ...defaultCustomization,
        fontFamily: "'Bangers', cursive",
        fontSize: 36,
        fontWeight: 400,
        textColor: '#ffffff',
        backgroundColor: '#ff6b35',
        backgroundOpacity: 90,
        borderRadius: 20,
        borderWidth: 4,
        borderColor: '#000000',
        strokeEnabled: true,
        strokeWidth: 3,
        strokeColor: '#000000',
        textShadowEnabled: true,
        textShadowColor: '#ff0000',
        textShadowBlur: 5,
        preset: 'comic'
      },
      horror: {
        ...defaultCustomization,
        fontFamily: "'Nosifer', cursive",
        fontSize: 34,
        fontWeight: 400,
        textColor: '#8b0000',
        backgroundColor: '#000000',
        backgroundOpacity: 95,
        borderRadius: 5,
        glowEnabled: true,
        glowColor: '#8b0000',
        glowIntensity: 30,
        textShadowEnabled: true,
        textShadowColor: '#ff0000',
        textShadowBlur: 20,
        textShadowOffsetY: 5,
        letterSpacing: 2,
        strokeEnabled: false,
        preset: 'horror'
      },
      luxury: {
        ...defaultCustomization,
        fontFamily: "'Playfair Display', serif",
        fontSize: 35,
        fontWeight: 400,
        textColor: '#ffd700',
        backgroundColor: '#1a1a1a',
        backgroundOpacity: 80,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#ffd700',
        textShadowEnabled: true,
        textShadowColor: '#000000',
        textShadowBlur: 10,
        letterSpacing: 2,
        lineHeight: 1.4,
        strokeEnabled: false,
        preset: 'luxury'
      },
      kawaii: {
        ...defaultCustomization,
        fontFamily: "'Comfortaa', cursive",
        fontSize: 30,
        fontWeight: 600,
        textColor: '#ff69b4',
        backgroundColor: '#ffffff',
        backgroundOpacity: 85,
        borderRadius: 25,
        borderWidth: 3,
        borderColor: '#ff69b4',
        textShadowEnabled: true,
        textShadowColor: '#ffb6c1',
        textShadowBlur: 8,
        strokeEnabled: false,
        preset: 'kawaii'
      },
      grunge: {
        ...defaultCustomization,
        fontFamily: "'Righteous', cursive",
        fontSize: 32,
        fontWeight: 400,
        textColor: '#ffffff',
        backgroundColor: '#2f2f2f',
        backgroundOpacity: 90,
        borderRadius: 0,
        strokeEnabled: true,
        strokeWidth: 2,
        strokeColor: '#000000',
        textShadowEnabled: true,
        textShadowColor: '#000000',
        textShadowBlur: 15,
        textShadowOffsetY: 3,
        letterSpacing: 1,
        preset: 'grunge'
      },
      corporate: {
        ...defaultCustomization,
        fontFamily: "'Open Sans', sans-serif",
        fontSize: 28,
        fontWeight: 400,
        textColor: '#2c3e50',
        backgroundColor: '#ecf0f1',
        backgroundOpacity: 90,
        borderRadius: 5,
        borderWidth: 1,
        borderColor: '#bdc3c7',
        textShadowEnabled: false,
        letterSpacing: 0.5,
        lineHeight: 1.3,
        strokeEnabled: false,
        preset: 'corporate'
      },
      anime: {
        ...defaultCustomization,
        fontFamily: "'Nunito', sans-serif",
        fontSize: 32,
        fontWeight: 700,
        textColor: '#ffffff',
        backgroundColor: '#ff6b9d',
        backgroundOpacity: 85,
        borderRadius: 15,
        borderWidth: 2,
        borderColor: '#ffffff',
        strokeEnabled: true,
        strokeWidth: 1,
        strokeColor: '#ff1493',
        textShadowEnabled: true,
        textShadowColor: '#ff1493',
        textShadowBlur: 8,
        preset: 'anime'
      },
      vaporwave: {
        ...defaultCustomization,
        fontFamily: "'Orbitron', sans-serif",
        fontSize: 34,
        fontWeight: 300,
        gradientEnabled: true,
        gradientColorStart: '#ff00ff',
        gradientColorEnd: '#00ffff',
        gradientDirection: '45deg',
        backgroundColor: '#1a0033',
        backgroundOpacity: 90,
        borderRadius: 0,
        glowEnabled: true,
        glowColor: '#ff00ff',
        glowIntensity: 20,
        letterSpacing: 4,
        textTransform: 'uppercase',
        strokeEnabled: false,
        preset: 'vaporwave'
      },
      steampunk: {
        ...defaultCustomization,
        fontFamily: "'Cinzel', serif",
        fontSize: 30,
        fontWeight: 600,
        textColor: '#cd853f',
        backgroundColor: '#2f1b14',
        backgroundOpacity: 90,
        borderRadius: 8,
        borderWidth: 2,
        borderColor: '#8b4513',
        textShadowEnabled: true,
        textShadowColor: '#000000',
        textShadowBlur: 12,
        letterSpacing: 1,
        strokeEnabled: false,
        preset: 'steampunk'
      },
      noir: {
        ...defaultCustomization,
        fontFamily: "'Bebas Neue', sans-serif",
        fontSize: 36,
        fontWeight: 400,
        textColor: '#ffffff',
        backgroundColor: '#000000',
        backgroundOpacity: 95,
        borderRadius: 0,
        textShadowEnabled: true,
        textShadowColor: '#333333',
        textShadowBlur: 20,
        textShadowOffsetY: 8,
        letterSpacing: 3,
        textTransform: 'uppercase',
        strokeEnabled: false,
        preset: 'noir'
      },
      pastel: {
        ...defaultCustomization,
        fontFamily: "'Quicksand', sans-serif",
        fontSize: 28,
        fontWeight: 500,
        textColor: '#6b5b95',
        backgroundColor: '#f8f8ff',
        backgroundOpacity: 85,
        borderRadius: 20,
        borderWidth: 2,
        borderColor: '#dda0dd',
        textShadowEnabled: true,
        textShadowColor: '#e6e6fa',
        textShadowBlur: 6,
        strokeEnabled: false,
        preset: 'pastel'
      },
      bold: {
        ...defaultCustomization,
        fontFamily: "'Anton', sans-serif",
        fontSize: 42,
        fontWeight: 400,
        textColor: '#ffffff',
        backgroundColor: '#000000',
        backgroundOpacity: 90,
        borderRadius: 5,
        strokeEnabled: true,
        strokeWidth: 4,
        strokeColor: '#ff0000',
        textShadowEnabled: true,
        textShadowColor: '#ff0000',
        textShadowBlur: 10,
        letterSpacing: 2,
        textTransform: 'uppercase',
        preset: 'bold'
      },
      sketch: {
        ...defaultCustomization,
        fontFamily: "'Kalam', cursive",
        fontSize: 30,
        fontWeight: 400,
        textColor: '#2c3e50',
        backgroundColor: '#ffffff',
        backgroundOpacity: 80,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: '#34495e',
        strokeEnabled: true,
        strokeWidth: 1,
        strokeColor: '#7f8c8d',
        preset: 'sketch'
      },
      glitch: {
        ...defaultCustomization,
        fontFamily: "'Courier New', monospace",
        fontSize: 32,
        fontWeight: 700,
        textColor: '#00ff00',
        backgroundColor: '#000000',
        backgroundOpacity: 95,
        borderRadius: 0,
        glowEnabled: true,
        glowColor: '#00ff00',
        glowIntensity: 35,
        textShadowEnabled: true,
        textShadowColor: '#ff0000',
        textShadowBlur: 8,
        textShadowOffsetY: 2,
        letterSpacing: 3,
        textTransform: 'uppercase',
        strokeEnabled: false,
        preset: 'glitch'
      },
      royal: {
        ...defaultCustomization,
        fontFamily: "'Cinzel', serif",
        fontSize: 34,
        fontWeight: 600,
        textColor: '#ffd700',
        backgroundColor: '#4b0082',
        backgroundOpacity: 90,
        borderRadius: 10,
        borderWidth: 3,
        borderColor: '#ffd700',
        textShadowEnabled: true,
        textShadowColor: '#000000',
        textShadowBlur: 15,
        letterSpacing: 2,
        lineHeight: 1.4,
        strokeEnabled: false,
        preset: 'royal'
      },
      sunset: {
        ...defaultCustomization,
        fontFamily: "'Poppins', sans-serif",
        fontSize: 32,
        fontWeight: 500,
        gradientEnabled: true,
        gradientColorStart: '#ff7e5f',
        gradientColorEnd: '#feb47b',
        gradientDirection: '135deg',
        backgroundColor: '#2c1810',
        backgroundOpacity: 75,
        borderRadius: 15,
        textShadowEnabled: true,
        textShadowColor: '#8b4513',
        textShadowBlur: 10,
        strokeEnabled: false,
        preset: 'sunset'
      },
      ocean: {
        ...defaultCustomization,
        fontFamily: "'Merriweather', serif",
        fontSize: 30,
        fontWeight: 400,
        gradientEnabled: true,
        gradientColorStart: '#667eea',
        gradientColorEnd: '#764ba2',
        gradientDirection: '90deg',
        backgroundColor: '#1e3c72',
        backgroundOpacity: 80,
        borderRadius: 12,
        textShadowEnabled: true,
        textShadowColor: '#0f1419',
        textShadowBlur: 8,
        strokeEnabled: false,
        preset: 'ocean'
      },
      forest: {
        ...defaultCustomization,
        fontFamily: "'Lora', serif",
        fontSize: 28,
        fontWeight: 400,
        textColor: '#90ee90',
        backgroundColor: '#2d5016',
        backgroundOpacity: 85,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#228b22',
        textShadowEnabled: true,
        textShadowColor: '#006400',
        textShadowBlur: 12,
        letterSpacing: 0.5,
        strokeEnabled: false,
        preset: 'forest'
      }
    };

  const hasChanges = useMemo(() => {
    return hasCustomizationChanged(customization, presets);
  }, [customization]);

  const applyPreset = (preset) => {
    const presetConfig = presets[preset] || presets.default;
    // Ensure all properties are reset to prevent bleeding between presets
    onChange({ ...defaultCustomization, ...presetConfig });
  };

  const applyCustomPreset = (customPreset) => {
    onChange({ ...defaultCustomization, ...customPreset.customization, preset: customPreset.id });
  };

  const handleDeleteCustomPreset = (presetId) => {
    const updated = deleteCustomSubtitlePreset(presetId);
    setCustomPresets(updated);
  };

  const handleSavePreset = () => {
    if (!hasChanges || isSaving) return;
    setShowNamingModal(true);
  };

  const handleModalSave = async (presetName) => {
    setIsSaving(true);

    try {
      const updatedPresets = addCustomSubtitlePreset({
        name: presetName,
        customization: { ...customization }
      });

      // Update the parent component's custom presets state
      setCustomPresets(updatedPresets);

      // Update the customization to reflect the new preset
      onChange({ ...customization, preset: updatedPresets[updatedPresets.length - 1].id });
    } catch (error) {
      console.error('Error saving custom preset:', error);
      alert(t('subtitleSettings.presetButtons.saveError', 'Failed to save custom preset.'));
    } finally {
      setIsSaving(false);
    }
  };


  return (
    <div className="customization-row preset-row">
      <div className="preset-buttons">
        {/* Predefined preset buttons */}
        {['default', 'modern', 'classic', 'neon', 'minimal', 'gaming', 'cinematic', 'gradient', 'retro', 'elegant', 'cyberpunk', 'vintage', 'comic', 'horror', 'luxury', 'kawaii', 'grunge', 'corporate', 'anime', 'vaporwave', 'steampunk', 'noir', 'pastel', 'bold', 'sketch', 'glitch', 'royal', 'sunset', 'ocean', 'forest'].map(preset => (
          <button
            key={preset}
            className={`pill-button ${customization.preset === preset ? 'primary' : 'secondary'}`}
            onClick={() => applyPreset(preset)}
            style={{ fontFamily: presets[preset].fontFamily }}
          >
            {preset.charAt(0).toUpperCase() + preset.slice(1)}
          </button>
        ))}

        {/* Custom preset buttons */}
        {customPresets.map(customPreset => (
          <div key={customPreset.id} className="custom-preset-button-container">
            <button
              className={`pill-button custom-preset-button ${customization.preset === customPreset.id ? 'primary' : 'secondary'}`}
              onClick={() => applyCustomPreset(customPreset)}
              title={customPreset.name}
              style={{ fontFamily: customPreset.customization.fontFamily }}
            >
              {customPreset.name}
            </button>
            <button
              className="custom-preset-delete-button pc-clear"
              onClick={() => handleDeleteCustomPreset(customPreset.id)}
              title="Delete preset"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor">
                <path d="m480-384-67 66q-20 20-47.5 20.5T318-318q-20-20-20-48t20-47l66-67-67-67q-20-20-20-47.5t21-47.5q20-20 47.5-20t47.5 20l67 66 67-66q20-20 47.5-20t47.5 20q20 19 20 47t-20 48l-66 67 66 67q20 20 20 47.5T642-318q-19 19-47 19t-48-19l-67-66Z"/>
              </svg>
            </button>
          </div>
        ))}

        {/* Save preset button */}
        <button
          className={`pill-button save-preset-button ${hasChanges ? 'primary' : 'secondary'}`}
          onClick={handleSavePreset}
          disabled={!hasChanges || isSaving}
          title={hasChanges ? t('subtitleSettings.presetButtons.saveCurrentSettings', 'Save current settings as preset') : t('subtitleSettings.presetButtons.noChangesToSave', 'No changes to save')}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>save</span>
          {t('subtitleSettings.presetButtons.savePreset', 'Save Preset')}
        </button>

      </div>

      {/* Preset naming modal */}
      <PresetNamingModal
        isOpen={showNamingModal}
        onClose={() => setShowNamingModal(false)}
        onSave={handleModalSave}
      />

    </div>
  );
};

export default PresetButtons;
