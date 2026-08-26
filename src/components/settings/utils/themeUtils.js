import { SunIcon, MoonIcon } from '../icons/TabIcons';
import {
  commitThemePreference,
  initializeEffectiveTheme,
  oppositeTheme,
  subscribeToEffectiveSystemTheme,
} from '../../../platform/themePreference';

// Function to toggle between light and dark themes
export const toggleTheme = async (
  theme,
  setTheme,
  {
    commitPreference = commitThemePreference,
    onProjectionWarning,
  } = {},
) => {
  const newTheme = oppositeTheme(theme);
  if (onProjectionWarning === undefined) {
    await commitPreference(newTheme);
  } else {
    await commitPreference(newTheme, { onProjectionWarning });
  }
  setTheme(newTheme);
  return newTheme;
};

// Get icon for the current theme
export const getThemeIcon = (theme) => {
  return theme === 'dark' ? <SunIcon /> : <MoonIcon />;
};

// Get aria-label for the theme toggle button
export const getThemeLabel = (theme, t) => {
  // Return the opposite of current theme to indicate what will happen on click
  return theme === 'dark' ? t('theme.light') : t('theme.dark');
};

// Initialize theme from localStorage or detect system preference
export const initializeTheme = initializeEffectiveTheme;

// Set up system theme change listener (re-exported from systemDetection utility)
export const setupSystemThemeListener = subscribeToEffectiveSystemTheme;
