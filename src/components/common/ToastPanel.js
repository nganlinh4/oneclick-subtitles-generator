import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './ToastPanel.css';

// Initialize window.addToast as a no-op to prevent errors before component mounts
if (typeof window !== 'undefined' && !window.addToast) {
  window.addToast = () => {};
}

const ToastPanel = () => {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  const [swipingToast, setSwipingToast] = useState(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const [isOnboardingActive, setIsOnboardingActive] = useState(false);

  // Check if onboarding is active
  useEffect(() => {
    const checkOnboardingStatus = () => {
      const hasVisited = localStorage.getItem('has_visited_site') === 'true';
      const controlsDismissed = localStorage.getItem('onboarding_controls_dismissed') === 'true';
      setIsOnboardingActive(!(hasVisited && controlsDismissed));
    };

    // Check initially
    checkOnboardingStatus();

    // Listen for storage changes (in case onboarding completes in another tab)
    const handleStorageChange = (e) => {
      if (e.key === 'has_visited_site' || e.key === 'onboarding_controls_dismissed') {
        checkOnboardingStatus();
      }
    };

    window.addEventListener('storage', handleStorageChange);

    // Also poll every second during onboarding to catch local changes
    const pollInterval = setInterval(() => {
      if (isOnboardingActive) {
        checkOnboardingStatus();
      }
    }, 1000);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      clearInterval(pollInterval);
    };
  }, [isOnboardingActive]);

  // This effect sets up the global function and event listeners
  useEffect(() => {
    // Global function to add a toast
    window.addToast = (message, type = 'info', duration = 6000, key, button) => {
      // Don't show toasts during onboarding
      if (isOnboardingActive) {
        return;
      }

      setToasts(prev => {
        const existingIndex = key ? prev.findIndex(t => t.key === key) : -1;

        if (existingIndex >= 0) {
          // Update existing toast and reset its timer
          const updatedToasts = [...prev];
          const existingToast = updatedToasts[existingIndex];

          if (existingToast.timerId) {
            clearTimeout(existingToast.timerId);
          }

          updatedToasts[existingIndex] = {
            ...existingToast,
            message,
            type,
            duration,
            timerId: setTimeout(() => removeToast(existingToast.id), duration),
          };
          return updatedToasts;
        } else {
          // Create a new toast
          const id = ++toastIdRef.current;
          const newToast = {
            id,
            message,
            type,
            duration,
            key,
            button,
            timerId: setTimeout(() => removeToast(id), duration),
          };
          // Prepend new toast to show it at the bottom with flex-direction: column-reverse
          return [newToast, ...prev];
        }
      });
    };

    // Global function to remove a toast by key
    window.removeToastByKey = (key) => {
      setToasts(prev => {
        const toRemove = prev.find(t => t.key === key);
        if (toRemove) {
          if (toRemove.timerId) clearTimeout(toRemove.timerId);
          return prev.filter(t => t.key !== key);
        }
        return prev;
      });
    };

    const handleAlignedNarrationStatus = (event) => {
      const { status, message } = event.detail;
      if (status === 'error' && message) {
        // Check if onboarding is active before showing toast
        const hasVisited = localStorage.getItem('has_visited_site') === 'true';
        const controlsDismissed = localStorage.getItem('onboarding_controls_dismissed') === 'true';
        const isOnboardingActive = !(hasVisited && controlsDismissed);

        if (!isOnboardingActive) {
          window.addToast(message, 'error', 8000);
        }
      }
    };

    const handleTranslationWarning = (event) => {
      const { message } = event.detail;
      if (message) {
        // Check if onboarding is active before showing toast
        const hasVisited = localStorage.getItem('has_visited_site') === 'true';
        const controlsDismissed = localStorage.getItem('onboarding_controls_dismissed') === 'true';
        const isOnboardingActive = !(hasVisited && controlsDismissed);

        if (!isOnboardingActive) {
          window.addToast(message, 'warning', 5000);
        }
      }
    };

    window.addEventListener('aligned-narration-status', handleAlignedNarrationStatus);
    window.addEventListener('translation-warning', handleTranslationWarning);

    // Cleanup function
    return () => {
      // Clear all timers when the component unmounts
      setToasts(prev => {
        prev.forEach(toast => toast.timerId && clearTimeout(toast.timerId));
        return [];
      });
      delete window.addToast;
      delete window.removeToastByKey;
      window.removeEventListener('aligned-narration-status', handleAlignedNarrationStatus);
      window.removeEventListener('translation-warning', handleTranslationWarning);
    };
  }, [isOnboardingActive]); // Re-run when onboarding status changes

  const removeToast = (id) => {
    setToasts(prev => prev.map(t =>
      t.id === id ? { ...t, dismissing: true } : t
    ));

    // Remove from state after the animation completes
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 500); // This duration should match the hide-toast animation
  };

  const handleTouchStart = (e, toastId) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    setSwipingToast(toastId);
  };

  const handleTouchMove = (e) => {
    if (!swipingToast) return;

    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const deltaX = currentX - touchStartX.current;
    const deltaY = Math.abs(currentY - touchStartY.current);

    // Only allow horizontal swipe if vertical movement is minimal
    if (deltaY < 50) {
      setSwipeOffset(deltaX);
    }
  };

  const handleTouchEnd = () => {
    if (!swipingToast) return;

    const threshold = 100; // Minimum swipe distance to dismiss

    if (Math.abs(swipeOffset) > threshold) {
      // Swipe far enough, dismiss the toast
      removeToast(swipingToast);
    }

    // Reset swipe state
    setSwipingToast(null);
    setSwipeOffset(0);
  };

  return (
    <div className="toast-panel">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast-item toast-${toast.type} ${toast.dismissing ? 'dismissing' : 'show'} ${swipingToast === toast.id ? 'swiping' : ''}`}
          onTouchStart={(e) => handleTouchStart(e, toast.id)}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{
            transform: swipingToast === toast.id ? `translateX(${swipeOffset}px)` : 'translateX(0)',
            transition: swipingToast === toast.id ? 'none' : 'transform 0.3s ease'
          }}
        >
          <div className={`toast toast-${toast.type}`}>
            <span className="material-symbols-rounded close-icon" onClick={() => removeToast(toast.id)}>close</span>
            <h3>{t(`common.toast.${toast.type}`)}</h3>
            <p>{toast.message}</p>
            {toast.button && (
              <button
                className="toast-button"
                onClick={() => {
                  if (toast.button.onClick) {
                    toast.button.onClick();
                  }
                  removeToast(toast.id);
                }}
              >
                {toast.button.text}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

export default ToastPanel;