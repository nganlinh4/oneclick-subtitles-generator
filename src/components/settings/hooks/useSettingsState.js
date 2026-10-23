import { useEffect, useMemo, useState } from 'react';

import {
  cancelYouTubeOAuthNative,
  getYouTubeOAuthStatusNative,
} from '../../../platform/providerService';
import {
  CREDENTIAL_DRAFT_FIELDS,
  PREFERENCE_FIELDS,
  isSameSettingsForm,
  loadSettingsForm,
} from './settingsFormFields';

const FORM_FIELDS = Object.freeze([...CREDENTIAL_DRAFT_FIELDS, ...Object.keys(PREFERENCE_FIELDS)]);
const VISIBILITY_FIELDS = Object.freeze([
  'showYoutubeKey',
  'showGeniusKey',
  'showClientId',
  'showClientSecret',
]);

const setterName = (field) => `set${field[0].toUpperCase()}${field.slice(1)}`;

/**
 * The Settings modal's draft form. It loads from the preference store, compares against the
 * snapshot it was loaded (or last saved) from, and exposes one value + setter per field.
 */
const useSettingsState = () => {
  const [form, setForm] = useState(loadSettingsForm);
  const [originalSettings, setOriginalSettings] = useState(() => form);
  const [visibility, setVisibility] = useState(() => Object.fromEntries(
    VISIBILITY_FIELDS.map((field) => [field, false])
  ));
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    let active = true;
    getYouTubeOAuthStatusNative()
      .then(({ authenticated }) => {
        if (active) setIsAuthenticated(authenticated);
      })
      .catch(() => {
        if (active) setIsAuthenticated(false);
      });
    return () => {
      active = false;
      cancelYouTubeOAuthNative().catch(() => undefined);
    };
  }, []);

  const setters = useMemo(() => Object.fromEntries([
    ...FORM_FIELDS.map((field) => [setterName(field), (value) => setForm((current) => ({
      ...current,
      [field]: typeof value === 'function' ? value(current[field]) : value,
    }))]),
    ...VISIBILITY_FIELDS.map((field) => [setterName(field), (value) => setVisibility((current) => ({
      ...current,
      [field]: typeof value === 'function' ? value(current[field]) : value,
    }))]),
  ]), []);

  return {
    ...form,
    ...visibility,
    ...setters,
    hasChanges: !isSameSettingsForm(form, originalSettings),
    isAuthenticated,
    setIsAuthenticated,
    originalSettings,
    setOriginalSettings,
  };
};

export default useSettingsState;
