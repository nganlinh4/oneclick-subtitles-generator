import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './ToastPanel.css';

// Initialize window.addToast as a no-op to prevent errors before component mounts
if (typeof window !== 'undefined' && !window.addToast) {
  window.addToast = () => {};
}

const ToastPanel = () => {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState([]); // Live, active toasts
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
    checkOnboardingStatus();
    const handleStorageChange = (e) => {
      if (e.key === 'has_visited_site' || e.key === 'onboarding_controls_dismissed') {
        checkOnboardingStatus();
      }
    };
    window.addEventListener('storage', handleStorageChange);
    const pollInterval = setInterval(() => {
      if (isOnboardingActive) checkOnboardingStatus();
    }, 1000);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      clearInterval(pollInterval);
    };
  }, [isOnboardingActive]);

  // This effect sets up the global function and event listeners
  useEffect(() => {
    window.addToast = (message, type = 'info', duration = 6000, key, button) => {
      if (isOnboardingActive) return;
      setToasts(prev => {
        const existingIndex = key ? prev.findIndex(t => t.key === key) : -1;
        if (existingIndex >= 0) {
          const updatedToasts = [...prev];
          const existingToast = updatedToasts[existingIndex];
          if (existingToast.timerId) clearTimeout(existingToast.timerId);
          updatedToasts[existingIndex] = {
            ...existingToast, message, type, duration,
            timerId: setTimeout(() => removeToast(existingToast.id), duration),
          };
          return updatedToasts;
        } else {
          const id = ++toastIdRef.current;
          const newToast = {
            id, message, type, duration, key, button,
            timestamp: Date.now(),
            timerId: setTimeout(() => removeToast(id), duration),
          };
          return [newToast, ...prev];
        }
      });
    };
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
      if (status === 'error' && message && !isOnboardingActive) {
        window.addToast(message, 'error', 8000);
      }
    };
    const handleTranslationWarning = (event) => {
      const { message } = event.detail;
      if (message && !isOnboardingActive) {
        window.addToast(message, 'warning', 5000);
      }
    };
    window.addEventListener('aligned-narration-status', handleAlignedNarrationStatus);
    window.addEventListener('translation-warning', handleTranslationWarning);
    return () => {
      setToasts(prev => {
        prev.forEach(toast => toast.timerId && clearTimeout(toast.timerId));
        return [];
      });
      delete window.addToast;
      delete window.removeToastByKey;
      window.removeEventListener('aligned-narration-status', handleAlignedNarrationStatus);
      window.removeEventListener('translation-warning', handleTranslationWarning);
    };
  }, [isOnboardingActive]);

  const removeToast = (id) => {
    setToasts(prev => prev.map(t =>
      t.id === id ? { ...t, dismissing: true } : t
    ));
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 500);
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
    if (deltaY < 50) {
      e.preventDefault(); // Prevent page scroll while swiping toast
      setSwipeOffset(deltaX);
    }
  };
  
  const handleTouchEnd = () => {
    if (!swipingToast) return;
    if (Math.abs(swipeOffset) > 100) {
      removeToast(swipingToast);
    }
    setSwipingToast(null);
    setSwipeOffset(0);
  };

  /* ----------------- New Revamped History Logic ----------------- */
    const [toastHistory, setToastHistory] = useState(() => {
      try {
        const raw = localStorage.getItem('toast_history_v1');
        return raw ? JSON.parse(raw) : [];
      } catch (e) { return []; }
    });
    
    const [isHistoryVisible, setIsHistoryVisible] = useState(false);
    const [isHistoryPinned, setIsHistoryPinned] = useState(false);
    const [isHistoryHiding, setIsHistoryHiding] = useState(false); // ADDED: State for closing animation
    const [showHistoryButton, setShowHistoryButton] = useState(true);
    const hideButtonTimeout = useRef(null);
    
    // Pagination / incremental loading for history
    const [historyLimit, setHistoryLimit] = useState(50);
    const historyContainerRef = useRef(null);
    
    // Persist history to localStorage
    useEffect(() => {
      try {
        const MAX_HISTORY = 200; // Limit stored history
        const toSave = toastHistory.length > MAX_HISTORY ? toastHistory.slice(-MAX_HISTORY) : toastHistory;
        localStorage.setItem('toast_history_v1', JSON.stringify(toSave));
      } catch (e) { /* ignore */ }
    }, [toastHistory]);
    
    // Add new toasts to history
    useEffect(() => {
      const latestToast = toasts[0];
      if (!latestToast) return;
    
      // Add to history only if it's a genuinely new toast
      if (!toastHistory.some(h => h.id === latestToast.id)) {
          // We clone the toast but remove the timerId to prevent it from auto-dismissing from history
          const { timerId, ...historyToast } = latestToast;
          setToastHistory(prev => [historyToast, ...prev]);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [toasts]);
    
    // Mouse proximity for floating button (bottom-right)
    useEffect(() => {
      const handleMouseMove = (e) => {
        const proximity = 120;
        const nearRight = e.clientX > window.innerWidth - proximity;
        const nearBottom = e.clientY > window.innerHeight - proximity;
        if (nearRight && nearBottom) {
          if (hideButtonTimeout.current) clearTimeout(hideButtonTimeout.current);
          setShowHistoryButton(true);
        } else {
          if (!isHistoryPinned && !isHistoryVisible) {
            if (hideButtonTimeout.current) clearTimeout(hideButtonTimeout.current);
            hideButtonTimeout.current = setTimeout(() => setShowHistoryButton(false), 500);
          }
        }
      };
      window.addEventListener('mousemove', handleMouseMove);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        if (hideButtonTimeout.current) clearTimeout(hideButtonTimeout.current);
      };
    }, [isHistoryPinned, isHistoryVisible]);
    
    // MODIFIED: Toggle the "pinned" state with exit animation
    const toggleHistoryPin = () => {
      // Prevent clicking while the closing animation is running
      if (isHistoryHiding) return;

      if (isHistoryPinned) {
        // Start closing animation
        setIsHistoryHiding(true);
        // After animation, fully hide the panel
        setTimeout(() => {
          setIsHistoryPinned(false);
          setIsHistoryHiding(false);
        }, 500); // This duration must match the CSS animation
      } else {
        // Just open it, no delay needed
        setIsHistoryPinned(true);
      }
    };
    
    const showAll = isHistoryPinned || isHistoryHiding;
    // If showing history, render up to `historyLimit` most recent items (newest at bottom).
    const toastsToRender = showAll
      ? [...toastHistory].slice(0, historyLimit).reverse()
      : toasts;
    
    // Handle incremental loading when user scrolls to top of the history container
    const handleHistoryScroll = (e) => {
      const el = e.target;
      // If scrolled to top and there are more items to load, increase the limit
      if (el.scrollTop === 0 && toastHistory.length > historyLimit) {
        // store previous scrollHeight so we can preserve scroll position after DOM update
        el._prevScrollHeight = el.scrollHeight;
        setHistoryLimit(prev => Math.min(prev + 50, toastHistory.length));
      }
    };
    
    // When history opens, reset limit and scroll to bottom (show newest)
    useEffect(() => {
      if (showAll && historyContainerRef.current) {
        setHistoryLimit(50);
        // wait for next paint then scroll to bottom
        requestAnimationFrame(() => {
          const el = historyContainerRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    }, [showAll]);
    
    // After loading more items, preserve the user's visible viewport by adjusting scrollTop
    useEffect(() => {
      const el = historyContainerRef.current;
      if (!el) return;
      // run after DOM update
      requestAnimationFrame(() => {
        if (el._prevScrollHeight) {
          const delta = el.scrollHeight - el._prevScrollHeight;
          // move scrollTop down by delta so content doesn't jump
          el.scrollTop = delta;
          delete el._prevScrollHeight;
        }
      });
    }, [historyLimit]);

  /* ----------------- Render ----------------- */
  return (
    <>
      <div className="toast-panel-wrapper">
        <div
          className="toast-panel"
        >
          {showAll ? (
            <div
              // MODIFIED: Add a 'hiding' class to trigger the exit animation
              className={`toast-history-container ${isHistoryHiding ? 'hiding' : ''}`}
              ref={historyContainerRef}
              onScroll={handleHistoryScroll}
              onWheel={(e) => e.stopPropagation()}
              role="region"
              aria-label={t('common.toastHistory', 'Toast history')}
            >
              {toastsToRender.map((toast) => {
                const isHistorical = !toasts.some(liveToast => liveToast.id === toast.id);
                return (
                  <div
                    key={toast.id}
                    className={`toast-item ${isHistorical ? 'historical' : 'live'} ${toast.dismissing ? 'dismissing' : 'show'} ${swipingToast === toast.id ? 'swiping' : ''}`}
                    onTouchStart={!isHistorical ? (e) => handleTouchStart(e, toast.id) : undefined}
                    onTouchMove={!isHistorical ? handleTouchMove : undefined}
                    onTouchEnd={!isHistorical ? handleTouchEnd : undefined}
                    style={{
                      transform: swipingToast === toast.id ? `translateX(${swipeOffset}px)` : 'translateX(0)',
                      transition: swipingToast === toast.id ? 'none' : 'transform 0.3s ease',
                      animationDelay: isHistorical ? '0s' : undefined
                    }}
                  >
                    <div className={`toast toast-${toast.type}`}>
                      {!isHistorical && (
                        <span className="material-symbols-rounded close-icon" onClick={() => removeToast(toast.id)}>
                          close
                        </span>
                      )}
                      <h3>{t(`common.toast.${toast.type}`)}</h3>
                      <p>{toast.message}</p>
                      {isHistorical && (
                        <small className="toast-time">
                          {new Date(toast.timestamp).toLocaleString()}
                        </small>
                      )}
                      {toast.button && (
                        <button
                          className="toast-button"
                          onClick={() => {
                            if (toast.button.onClick) toast.button.onClick();
                            if (!isHistorical) removeToast(toast.id);
                          }}
                        >
                          {toast.button.text}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            toastsToRender.map((toast) => {
              const isHistorical = showAll && !toasts.some(liveToast => liveToast.id === toast.id);
              return (
                <div
                  key={toast.id}
                  className={`toast-item ${isHistorical ? 'historical' : 'live'} ${toast.dismissing ? 'dismissing' : 'show'} ${swipingToast === toast.id ? 'swiping' : ''}`}
                  onTouchStart={!isHistorical ? (e) => handleTouchStart(e, toast.id) : undefined}
                  onTouchMove={!isHistorical ? handleTouchMove : undefined}
                  onTouchEnd={!isHistorical ? handleTouchEnd : undefined}
                  style={{
                    transform: swipingToast === toast.id ? `translateX(${swipeOffset}px)` : 'translateX(0)',
                    transition: swipingToast === toast.id ? 'none' : 'transform 0.3s ease',
                    animationDelay: isHistorical ? '0s' : undefined
                  }}
                >
                  <div className={`toast toast-${toast.type}`}>
                    {!isHistorical && (
                      <span className="material-symbols-rounded close-icon" onClick={() => removeToast(toast.id)}>
                        close
                      </span>
                    )}
                    <h3>{t(`common.toast.${toast.type}`)}</h3>
                    <p>{toast.message}</p>
                    {toast.button && (
                      <button
                        className="toast-button"
                        onClick={() => {
                          if (toast.button.onClick) toast.button.onClick();
                          if (!isHistorical) removeToast(toast.id);
                        }}
                      >
                        {toast.button.text}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="toast-history-button-container">
        <button
          className={`toast-history-button ${showHistoryButton || isHistoryVisible || isHistoryPinned ? 'floating-visible' : 'floating-hidden'} ${isHistoryPinned ? 'active' : ''}`}
          onClick={toggleHistoryPin}
          aria-label={isHistoryPinned ? t('common.hideToastHistory') : t('common.showToastHistory')}
          title={isHistoryPinned ? t('common.hideToastHistory') : t('common.showToastHistory')}
          type="button"
        >
          <span className="material-symbols-rounded">{isHistoryPinned ? 'visibility_off' : 'history'}</span>
        </button>
      </div>
    </>
  );
};
  
export default ToastPanel;