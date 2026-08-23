/**
 * Utility functions for showing temporary toast notifications
 */

/**
 * Shows a temporary toast notification that auto-dismisses
 * @param {string} message - The message to display
 * @param {string} type - The type of toast ('info', 'error', 'success', 'warning')
 * @param {number} duration - Duration in milliseconds before auto-dismiss (default: 3000)
 * @param {string} className - Additional CSS class names
 */
export const showToast = (message, type = 'info', duration = 6000, className = '') => {
  // If ToastPanel is mounted, use it
  if (window.addToast) {
    window.addToast(message, type, duration);
    return;
  }

  // Fallback to DOM manipulation
  // Create the toast element
  const toast = document.createElement('div');
  toast.className = `custom-toast ${type} ${className}`;

  const icon = document.createElement('span');
  icon.className = 'material-symbols-rounded toast-icon';
  icon.style.fontSize = '20px';
  icon.textContent = type === 'error'
    ? 'error'
    : type === 'success'
      ? 'check'
      : type === 'warning' ? 'warning' : 'info';
  const messageNode = document.createElement('span');
  messageNode.className = 'toast-message';
  messageNode.textContent = String(message);
  toast.append(icon, messageNode);

  // Add to body
  document.body.appendChild(toast);

  // Trigger reflow to enable CSS transition
  void toast.offsetHeight;

  // Add visible class for fade-in animation with slight delay
  setTimeout(() => {
    toast.classList.add('visible');
  }, 10);

  // Auto-dismiss after duration
  setTimeout(() => {
    toast.classList.remove('visible');
    // Remove from DOM after fade-out animation
    setTimeout(() => {
      if (toast && toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }, duration);

  return toast;
};

/**
 * Shows an info toast
 */
export const showInfoToast = (message, duration = 6000, key) => {
  if (key && window.addToast) {
    window.addToast(message, 'info', duration, key);
    return;
  }
  return showToast(message, 'info', duration);
};

/**
 * Shows an error toast
 */
export const showErrorToast = (message, duration = 8000) => {
  return showToast(message, 'error', duration);
};

/**
 * Shows a success toast
 */
export const showSuccessToast = (message, duration = 6000) => {
  return showToast(message, 'success', duration);
};

/**
 * Shows a warning toast
 */
export const showWarningToast = (message, duration = 7000) => {
  return showToast(message, 'warning', duration);
};

/**
 * Shows a non-blocking confirmation through the application's existing toast action.
 * The callback is promise-safe because ToastPanel intentionally does not await button handlers.
 */
export const showConfirmationToast = ({
  message,
  confirmText,
  onConfirm,
  duration = 30_000,
  key,
}) => {
  if (typeof onConfirm !== 'function') {
    throw new TypeError('A confirmation action is required');
  }
  if (typeof window.addToast !== 'function') return false;
  window.addToast(message, 'warning', duration, key, {
    text: confirmText,
    onClick: () => Promise.resolve()
      .then(onConfirm)
      .catch((error) => {
        showErrorToast(error?.message || String(error));
        return false;
      }),
  });
  return true;
};
