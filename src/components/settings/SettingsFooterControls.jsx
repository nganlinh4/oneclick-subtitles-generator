import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import LanguageSelector from '../LanguageSelector';
import CustomDropdown from '../common/CustomDropdown';
import '../../styles/common/CustomDropdown.css';
import {
  APP_FONT_PREFERENCE,
  APP_UI_SCALE_PREFERENCE,
  applyEffectiveAppFont,
  applyEffectiveAppUiScale,
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
  const appScaleWriteInFlightRef = useRef(false);

  const [theme, setTheme] = useState(() => initializeTheme());
  const [appFont, setAppFont] = useState(() => (
    APP_FONT_PREFERENCE.readMirror('google-sans')
  ));
  const [appScale, setAppScale] = useState(() => (
    APP_UI_SCALE_PREFERENCE.readMirror('100')
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

  const handleAppScaleStep = async (direction) => {
    if (disabled || appScaleWriteInFlightRef.current) return;
    const values = APP_UI_SCALE_PREFERENCE.values;
    const currentIndex = values.indexOf(appScale);
    const nextScale = values[Math.max(0, Math.min(values.length - 1, currentIndex + direction))];
    if (nextScale === appScale) return;
    appScaleWriteInFlightRef.current = true;
    try {
      const committedScale = await APP_UI_SCALE_PREFERENCE.commit(nextScale, {
        apply: applyEffectiveAppUiScale,
        publish: (publishedScale) => window.dispatchEvent(new StorageEvent('storage', {
          key: APP_UI_SCALE_PREFERENCE.key,
          newValue: publishedScale,
        })),
        onProjectionWarning: () => showPreferenceProjectionWarning(t),
      });
      setAppScale(committedScale);
    } catch {
      window.addToast?.(
        t('settings.saveFailed', 'Settings could not be saved. Please try again.'),
        'error',
        8000,
      );
    } finally {
      appScaleWriteInFlightRef.current = false;
    }
  };

  const scaleControls = (
    <div className="app-ui-scale" aria-label={t('settings.appUiScale', 'Interface scale')}>
      <button
        type="button"
        onClick={() => handleAppScaleStep(-1)}
        disabled={disabled || appScale === APP_UI_SCALE_PREFERENCE.values[0]}
        aria-label={t('settings.decreaseUiScale', 'Decrease interface scale')}
      >−</button>
      <output aria-live="polite">{appScale}%</output>
      <button
        type="button"
        onClick={() => handleAppScaleStep(1)}
        disabled={disabled || appScale === APP_UI_SCALE_PREFERENCE.values.at(-1)}
        aria-label={t('settings.increaseUiScale', 'Increase interface scale')}
      >+</button>
    </div>
  );

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
          {scaleControls}
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
      {scaleControls}
    </div>
  );
};

export default SettingsFooterControls;
