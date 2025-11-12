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
  console.log(`[Toast] Creating ${type} toast:`, message);

  // If ToastPanel is mounted, use it
  if (window.addToast) {
    console.log(`[Toast] Using ToastPanel for ${type} toast`);
    window.addToast(message, type, duration);
    return;
  }

  console.log(`[Toast] Using fallback DOM creation for ${type} toast`);

  // Fallback to DOM manipulation
  // Create the toast element
  const toast = document.createElement('div');
  toast.className = `custom-toast ${type} ${className}`;

  // Add icon based on type
  const iconHTML = type === 'error' ?
    '<span class="material-symbols-rounded toast-icon" style="font-size: 20px;">error</span>' :
    type === 'success' ?
    '<span class="material-symbols-rounded toast-icon" style="font-size: 20px;">check</span>' :
    type === 'warning' ?
    '<span class="material-symbols-rounded toast-icon" style="font-size: 20px;">warning</span>' :
    '<span class="material-symbols-rounded toast-icon" style="font-size: 20px;">info</span>';

  toast.innerHTML = `
    ${iconHTML}
    <span class="toast-message">${message}</span>
  `;

  // Add to body
  document.body.appendChild(toast);

  // Trigger reflow to enable CSS transition
  // eslint-disable-next-line no-unused-expressions
  toast.offsetHeight;

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
export const showInfoToast = (message, duration = 6000) => {
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
