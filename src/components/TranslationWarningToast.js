import React, { useState, useEffect } from 'react';
import '../styles/TranslationWarningToast.css';

const TranslationWarningToast = () => {
  const [message, setMessage] = useState('');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handleWarning = (event) => {
      setMessage(event.detail.message);
      setVisible(true);

      // Hide the toast after 5 seconds
      setTimeout(() => {
        setVisible(false);
      }, 5000);
    };

    window.addEventListener('translation-warning', handleWarning);

    return () => {
      window.removeEventListener('translation-warning', handleWarning);
    };
  }, []);

  if (!visible) return null;

  return (
    <div className="translation-warning-toast">
      <div className="toast-icon">⚠️</div>
      <div className="toast-message">{message}</div>
      <button className="toast-close" onClick={() => setVisible(false)}>
        <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>close</span>
      </button>
    </div>
  );
};

export default TranslationWarningToast;
