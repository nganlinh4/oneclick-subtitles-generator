import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import LanguageSelector from '../LanguageSelector';
import CustomDropdown from '../common/CustomDropdown';
import '../../styles/common/CustomDropdown.css';
import { toggleTheme as toggleThemeUtil, getThemeIcon, getThemeLabel, initializeTheme, setupSystemThemeListener } from './utils/themeUtils';

/**
 * Reusable settings footer controls: Theme toggle + Language selector (+ optional Font selector)
 * - Keeps real-time updates (theme + i18n) like in SettingsModal
 * - size: 'normal' | 'large' (for onboarding reveal)
 * - layout: 'group' | 'split' (split places theme left, language right)
 */
const SettingsFooterControls = ({ isDropup = false, size = 'normal', layout = 'group', className = '', showFontDropdown = false }) => {
  const { t } = useTranslation();

  const [theme, setTheme] = useState(() => initializeTheme());
  const [appFont, setAppFont] = useState(() => localStorage.getItem('app_font') || 'google-sans');

  useEffect(() => {
    const cleanup = setupSystemThemeListener(setTheme);
    return () => cleanup && cleanup();
  }, []);

  const handleToggleTheme = () => {
    const newTheme = toggleThemeUtil(theme, setTheme);
    setTheme(newTheme);
  };

  // Apply selected font to CSS variables for the whole app
  useEffect(() => {
    const root = document.documentElement;
    let primary = `"Google Sans", "Open Sans", sans-serif`;
    let title = `"Google Sans", "Be Vietnam Pro", sans-serif`;

    if (appFont === 'product-sans') {
      primary = `"Product Sans", system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      title = `"Product Sans", system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    } else if (appFont === 'system-ui') {
      primary = `system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif`;
      title = primary;
    } else if (appFont === 'noto-sans') {
      primary = `"Noto Sans", "Open Sans", sans-serif`;
      title = primary;
    } else {
      // default: Google Sans Flex
      primary = `"Google Sans", "Open Sans", sans-serif`;
      title = `"Google Sans", "Be Vietnam Pro", sans-serif`;
    }

    root.style.setProperty('--font-primary', primary);
    root.style.setProperty('--font-title', title);
    localStorage.setItem('app_font', appFont);
    // Trigger reflow updates for components that read CSS vars
    const storageEvent = new StorageEvent('storage', { key: 'app_font', newValue: appFont });
    window.dispatchEvent(storageEvent);
  }, [appFont]);

  const fontOptions = useMemo(() => ([
    { value: 'google-sans', label: 'Google Sans Flex' },
    { value: 'product-sans', label: 'Google Sans (Product Sans)' },
    { value: 'system-ui', label: 'System UI' },
    { value: 'noto-sans', label: 'Noto Sans' },
  ]), []);

  if (layout === 'split') {
    return (
      <div className={`settings-footer-controls ${size === 'large' ? 'controls-large' : ''} split-layout ${className}`.trim()}>
        <div className="controls-left">
          <button
            className="theme-toggle"
            onClick={handleToggleTheme}
            aria-label={getThemeLabel(theme, t)}
            title={getThemeLabel(theme, t)}
          >
            {getThemeIcon(theme)}
          </button>
        </div>
        <div className="controls-right">
          {showFontDropdown && (
            <CustomDropdown
              value={appFont}
              onChange={setAppFont}
              options={fontOptions}
              className="app-font-dropdown"
            />
          )}
          <LanguageSelector isDropup={isDropup} />
        </div>
      </div>
    );
  }

  return (
    <div className={`settings-footer-controls ${size === 'large' ? 'controls-large' : ''} ${className}`.trim()}>
      <button
        className="theme-toggle"
        onClick={handleToggleTheme}
        aria-label={getThemeLabel(theme, t)}
        title={getThemeLabel(theme, t)}
      >
        {getThemeIcon(theme)}
      </button>
      {showFontDropdown && (
        <CustomDropdown
          value={appFont}
          onChange={setAppFont}
          options={fontOptions}
          className="app-font-dropdown"
        />
      )}
      <LanguageSelector isDropup={isDropup} />
    </div>
  );
};

export default SettingsFooterControls;
