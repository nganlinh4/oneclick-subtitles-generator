import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import LanguageSelector from '../LanguageSelector';
import CustomDropdown from '../common/CustomDropdown';
import '../../styles/common/CustomDropdown.css';
import {
  APP_FONT_PREFERENCE,
  applyEffectiveAppFont,
} from '../../platform/nativeUiPreferences';
import { toggleTheme as toggleThemeUtil, getThemeIcon, getThemeLabel, initializeTheme, setupSystemThemeListener } from './utils/themeUtils';
import { showPreferenceProjectionWarning } from './utils/preferenceProjectionWarning';

/**
 * Reusable settings footer controls: Theme toggle + Language selector (+ optional Font selector)
 * - Keeps real-time updates (theme + i18n) like in SettingsModal
 * - size: 'normal' | 'large' (for onboarding reveal)
 * - layout: 'group' | 'split' (split places theme left, language right)
 */
const SettingsFooterControls = ({
  isDropup = false,
  size = 'normal',
  layout = 'group',
  className = '',
  showFontDropdown = false,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const themeWriteInFlightRef = useRef(false);
  const appFontWriteInFlightRef = useRef(false);

  const [theme, setTheme] = useState(() => initializeTheme());
  const [appFont, setAppFont] = useState(() => (
    APP_FONT_PREFERENCE.readMirror('google-sans')
  ));

  useEffect(() => {
    const cleanup = setupSystemThemeListener(setTheme);
    return () => cleanup && cleanup();
  }, []);

  const handleToggleTheme = async () => {
    if (disabled || themeWriteInFlightRef.current) return;
    themeWriteInFlightRef.current = true;
    try {
      await toggleThemeUtil(theme, setTheme, {
        onProjectionWarning: () => showPreferenceProjectionWarning(t),
      });
    } catch {
      window.addToast?.(
        t('settings.saveFailed', 'Settings could not be saved. Please try again.'),
        'error',
        8000,
      );
    } finally {
      themeWriteInFlightRef.current = false;
    }
  };

  const handleAppFontChange = async (nextFont) => {
    if (disabled || appFontWriteInFlightRef.current) return;
    appFontWriteInFlightRef.current = true;
    try {
      const committedFont = await APP_FONT_PREFERENCE.commit(nextFont, {
        apply: applyEffectiveAppFont,
        publish: (publishedFont) => {
          window.dispatchEvent(new StorageEvent('storage', {
            key: APP_FONT_PREFERENCE.key,
            newValue: publishedFont,
          }));
        },
        onProjectionWarning: () => showPreferenceProjectionWarning(t),
      });
      // State is a separate projection from CSS and the storage event. Even if either one fails,
      // reflect durable native authority in this still-mounted control; startup hydrates it again.
      setAppFont(committedFont);
    } catch {
      window.addToast?.(
        t('settings.saveFailed', 'Settings could not be saved. Please try again.'),
        'error',
        8000,
      );
    } finally {
      appFontWriteInFlightRef.current = false;
    }
  };

  const fontOptions = useMemo(() => ([
    { value: 'google-sans', label: 'Google Sans Flex' },
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
            disabled={disabled}
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
              onChange={handleAppFontChange}
              options={fontOptions}
              className="app-font-dropdown"
              disabled={disabled}
            />
          )}
          <LanguageSelector isDropup={isDropup} disabled={disabled} />
        </div>
      </div>
    );
  }

  return (
    <div className={`settings-footer-controls ${size === 'large' ? 'controls-large' : ''} ${className}`.trim()}>
      <button
        className="theme-toggle"
        onClick={handleToggleTheme}
        disabled={disabled}
        aria-label={getThemeLabel(theme, t)}
        title={getThemeLabel(theme, t)}
      >
        {getThemeIcon(theme)}
      </button>
      {showFontDropdown && (
        <CustomDropdown
          value={appFont}
          onChange={handleAppFontChange}
          options={fontOptions}
          className="app-font-dropdown"
          disabled={disabled}
        />
      )}
      <LanguageSelector isDropup={isDropup} disabled={disabled} />
    </div>
  );
};

export default SettingsFooterControls;
