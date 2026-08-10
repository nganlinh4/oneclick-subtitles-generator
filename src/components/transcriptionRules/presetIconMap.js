
const iconStyle = { display: 'inline-block', verticalAlign: 'middle', marginRight: '6px', fontSize: 16 };

const MaterialIcon = ({ name }) => (
  <span className="material-symbols-rounded" style={iconStyle} aria-hidden="true">
    {name}
  </span>
);

/**
 * Returns an icon factory (a component) for a built-in preset based on its id.
 * Each factory renders the material-symbols icon associated with the preset.
 *
 * @param {Object} preset - A built-in preset with an `id`.
 * @returns {Function} A React component rendering the preset's icon.
 */
export const getPresetIconComponent = (preset) => {
  switch (preset.id) {
    case 'general':
      // General purpose - grid/dashboard icon
      return () => <MaterialIcon name="view_module" />;
    case 'extract-text':
      // Extract text - document with text lines icon
      return () => <MaterialIcon name="description" />;
    case 'focus-lyrics':
      // Focus on lyrics - music note icon
      return () => <MaterialIcon name="music_note" />;
    case 'describe-video':
      // Describe video - camera/video icon
      return () => <MaterialIcon name="videocam" />;
    case 'translate-directly':
      // Translate directly - globe/language icon
      return () => <MaterialIcon name="public" />;
    case 'chaptering':
      // Chaptering - list/bookmark icon
      return () => <MaterialIcon name="bookmark" />;
    case 'diarize-speakers':
      // Identify speakers - users/people icon
      return () => <MaterialIcon name="people" />;
    default:
      // Default clipboard icon for unknown presets
      return () => <MaterialIcon name="content_copy" />;
  }
};

/**
 * Resolves the localized title for a preset id.
 *
 * @param {string} presetId - The preset id (or 'custom').
 * @param {Array} allPresets - All available presets (built-in + user).
 * @param {Function} t - i18next translation function.
 * @returns {string} The localized preset title.
 */
export const getPresetTitle = (presetId, allPresets, t) => {
  if (presetId === 'custom') {
    return t('settings.promptFromSettings', 'Prompt from settings');
  }

  const preset = allPresets.find(p => p.id === presetId);
  if (!preset) return presetId;

  switch (preset.id) {
    case 'general':
      return t('settings.presetGeneralPurpose', 'General purpose');
    case 'extract-text':
      return t('settings.presetExtractText', 'Extract text');
    case 'focus-lyrics':
      return t('settings.presetFocusLyrics', 'Focus on Lyrics');
    case 'describe-video':
      return t('settings.presetDescribeVideo', 'Describe video');
    case 'translate-directly':
      return t('settings.presetTranslateDirectly', 'Translate directly');
    case 'chaptering':
      return t('settings.presetChaptering', 'Chaptering');
    case 'diarize-speakers':
      return t('settings.presetIdentifySpeakers', 'Identify Speakers');
    default:
      return preset.title || presetId;
  }
};
