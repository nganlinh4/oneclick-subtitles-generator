// Utility functions for managing custom subtitle presets

const STORAGE_KEY = 'user_subtitle_presets';

/**
 * Get all custom subtitle presets from localStorage
 * @returns {Array} Array of custom preset objects
 */
export const getCustomSubtitlePresets = () => {
  try {
    const savedPresets = localStorage.getItem(STORAGE_KEY);
    const parsed = savedPresets ? JSON.parse(savedPresets) : [];

    // Normalize any legacy entries and persist back if changes were made
    let changed = false;
    const normalized = parsed.map((p, idx) => {
      const np = { ...p };
      if (!np.customization && np.config) {
        np.customization = np.config; // migrate legacy key
        delete np.config;
        changed = true;
      }
      if (!np.id) {
        np.id = `custom_${np.createdAt || Date.now()}_${idx}`;
        changed = true;
      }
      if (!np.name) {
        np.name = `Custom ${idx + 1}`;
        changed = true;
      }
      return np;
    });

    if (changed) {
      saveCustomSubtitlePresets(normalized);
    }

    return normalized;
  } catch (error) {
    console.error('Error loading custom subtitle presets:', error);
    return [];
  }
};

/**
 * Save custom subtitle presets to localStorage
 * @param {Array} presets Array of custom preset objects
 */
export const saveCustomSubtitlePresets = (presets) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch (error) {
    console.error('Error saving custom subtitle presets:', error);
  }
};

/**
 * Add a new custom preset
 * @param {Object} preset The preset object to add
 * @returns {Array} Updated array of presets
 */
export const addCustomSubtitlePreset = (preset) => {
  const presets = getCustomSubtitlePresets();
  const newPreset = {
    id: `custom_${Date.now()}`,
    name: preset.name || `Custom ${presets.length + 1}`,
    customization: { ...preset.customization },
    createdAt: new Date().toISOString()
  };
  presets.push(newPreset);
  saveCustomSubtitlePresets(presets);
  return presets;
};

/**
 * Delete a custom preset by ID
 * @param {string} presetId The ID of the preset to delete
 * @returns {Array} Updated array of presets
 */
export const deleteCustomSubtitlePreset = (presetId) => {
  const presets = getCustomSubtitlePresets();
  const updatedPresets = presets.filter(preset => preset.id !== presetId);
  saveCustomSubtitlePresets(updatedPresets);
  return updatedPresets;
};

/**
 * Check if current customization differs from all presets (both predefined and custom)
 * @param {Object} currentCustomization Current customization object
 * @param {Object} predefinedPresets Object containing predefined presets
 * @returns {boolean} True if customization differs from all presets
 */
export const hasCustomizationChanged = (currentCustomization, predefinedPresets) => {
  const customPresets = getCustomSubtitlePresets();

  // Check against predefined presets
  for (const preset of Object.values(predefinedPresets)) {
    if (isEqualCustomization(currentCustomization, preset)) {
      return false;
    }
  }

  // Check against custom presets
  for (const preset of customPresets) {
    if (isEqualCustomization(currentCustomization, preset.customization)) {
      return false;
    }
  }

  return true;
};

/**
 * Check if two customization objects are equal (deep comparison)
 * @param {Object} a First customization object
 * @param {Object} b Second customization object
 * @returns {boolean} True if objects are equal
 */
const isEqualCustomization = (a, b) => {
  // Simple deep equality check for customization objects
  return JSON.stringify(a) === JSON.stringify(b);
};