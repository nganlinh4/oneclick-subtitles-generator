
import { useEffect } from 'react';
import { showInfoToast } from '../../utils/toastUtils';

const TRANSLATION_PROGRESS_TOAST_KEY = 'translation-progress';
const ACTIVE_PROGRESS_DURATION_MS = 60 * 60 * 1000;

/** Publishes progress through the global notification surface and owns no inline UI. */
const TranslationStatus = ({ status }) => {
  useEffect(() => {
    if (status) {
      showInfoToast(status, ACTIVE_PROGRESS_DURATION_MS, TRANSLATION_PROGRESS_TOAST_KEY);
    } else {
      window.removeToastByKey?.(TRANSLATION_PROGRESS_TOAST_KEY);
    }
  }, [status]);

  useEffect(() => () => {
    window.removeToastByKey?.(TRANSLATION_PROGRESS_TOAST_KEY);
  }, []);

  return null;
};

export default TranslationStatus;
