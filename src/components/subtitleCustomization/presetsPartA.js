// Predefined subtitle-customization presets (part A: default..cyberpunk). Pure data.
import { defaultCustomization } from './defaultCustomization';

export const presetsPartA = {
      default: defaultCustomization,
      modern: {
        // Text properties
        fontSize: 32,
        fontFamily: "'Google Sans', sans-serif",
        fontWeight: 400,
        textColor: '#ffffff',
        textAlign: 'center',
        lineHeight: 1.2,
        letterSpacing: 0,
        textTransform: 'none',

        // Background properties
        backgroundColor: '#1a1a1a',
        backgroundOpacity: 80,
        backgroundPaddingX: 16,
        backgroundPaddingY: 8,
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
        backgroundPaddingX: 16,
        backgroundPaddingY: 8,
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
        backgroundPaddingX: 16,
        backgroundPaddingY: 8,
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
        fontFamily: "'Google Sans', sans-serif",
        fontSize: 26,
        fontWeight: 300,
        backgroundColor: '#000000',
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
        fontFamily: "'Impact', sans-serif",
        fontSize: 36,
        fontWeight: 400,
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
        fontFamily: "'Georgia', serif",
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
        fontFamily: "'Google Sans', sans-serif",
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
        fontFamily: "'Courier New', monospace",
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
        fontFamily: "'Georgia', serif",
        fontSize: 30,
        fontWeight: 400,
        textColor: '#ffffff',
        backgroundColor: '#000000',
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
        fontFamily: "'Impact', sans-serif",
        fontSize: 38,
        fontWeight: 400,
        textColor: '#ff0080',
        backgroundColor: '#000000',
        backgroundOpacity: 95,
        borderRadius: 0,
        borderWidth: 3,
        borderColor: '#ff0080',
        borderStyle: 'solid',
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
};
