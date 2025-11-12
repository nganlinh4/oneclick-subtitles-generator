import React, { useEffect } from 'react';
import { showErrorToast } from '../../utils/toastUtils';

/**
 * Translation error component
 * @param {Object} props - Component props
 * @param {string} props.error - Error message
 * @returns {JSX.Element|null} - Rendered component or null if no error
 */
const TranslationError = ({ error }) => {
  useEffect(() => {
    if (error) {
      showErrorToast(error.replace(/<[^>]*>/g, '')); // Strip HTML tags for toast
    }
  }, [error]);

  return null; // No longer render inline error
};

export default TranslationError;
