import { SunIcon, MoonIcon } from '../icons/TabIcons';
import { getThemeWithFallback, setupSystemThemeListener } from '../../../utils/systemDetection';

// Function to toggle between light and dark themes
export const toggleTheme = (theme, setTheme) => {
  let newTheme;
  // Simple toggle between light and dark
  if (theme === 'light' || theme === 'system') {
    newTheme = 'dark';
  } else {
    newTheme = 'light';
  }

  setTheme(newTheme);
  localStorage.setItem('theme', newTheme);
  document.documentElement.setAttribute('data-theme', newTheme);

  // Force re-render by triggering a storage event
  window.dispatchEvent(new Event('storage'));
  
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
export const initializeTheme = () => {
  const theme = getThemeWithFallback();
  document.documentElement.setAttribute('data-theme', theme);

  // Save to localStorage if not already saved
  if (!localStorage.getItem('theme')) {
    localStorage.setItem('theme', theme);
  }

  return theme;
};

// Set up system theme change listener (re-exported from systemDetection utility)
export { setupSystemThemeListener };
