import { createRoot } from 'react-dom/client';
import LoadingIndicator from '../../common/LoadingIndicator';

/**
 * Create a React-based loading overlay with LoadingIndicator component
 * @param {string} message - Initial loading message
 * @returns {Object} - Object with container element, root, and update function
 */
export const createLoadingOverlay = (message) => {
  // Create container element
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.top = '50%';
  container.style.left = '50%';
  container.style.transform = 'translate(-50%, -50%)';
  container.style.padding = '24px';
  container.style.background = 'rgba(0, 0, 0, 0.85)';
  container.style.borderRadius = '16px';
  container.style.zIndex = '9999';
  container.style.textAlign = 'center';
  container.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.3)';
  container.style.minWidth = '280px';
  container.style.backdropFilter = 'blur(8px)';

  // Create React root
  const root = createRoot(container);
  let isDestroyed = false;
  let overlayState = {
    message,
    progress: null,
    detail: '',
  };

  // Loading component
  const LoadingOverlay = ({ message, progress, detail }) => (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '16px',
      color: 'white'
    }}>
      <LoadingIndicator
        theme="light"
        showContainer={false}
        size={48}
        className="download-loading-indicator"
      />
      <div style={{
        fontSize: '16px',
        fontWeight: '500',
        textAlign: 'center',
        lineHeight: '1.4'
      }}>
        {message}
      </div>
      {typeof progress === 'number' && (
        <div style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}>
          <div style={{
            width: '100%',
            height: '8px',
            background: 'rgba(255, 255, 255, 0.18)',
            borderRadius: '999px',
            overflow: 'hidden'
          }}>
            <div style={{
              width: `${Math.max(0, Math.min(100, progress))}%`,
              height: '100%',
              background: 'linear-gradient(90deg, #7dd3fc 0%, #60a5fa 50%, #34d399 100%)',
              borderRadius: '999px',
              transition: 'width 180ms ease'
            }} />
          </div>
          <div style={{
            fontSize: '13px',
            opacity: 0.9,
            textAlign: 'center'
          }}>
            {Math.round(progress)}%
          </div>
        </div>
      )}
      {detail ? (
        <div style={{
          fontSize: '12px',
          opacity: 0.8,
          textAlign: 'center',
          lineHeight: '1.4'
        }}>
          {detail}
        </div>
      ) : null}
    </div>
  );

  const render = () => {
    if (isDestroyed) {
      return;
    }

    root.render(
      <LoadingOverlay
        message={overlayState.message}
        progress={overlayState.progress}
        detail={overlayState.detail}
      />,
    );
  };

  // Render initial state
  render();

  // Add to document
  document.body.appendChild(container);

  return {
    container,
    root,
    updateMessage: (newMessage) => {
      if (isDestroyed) {
        return;
      }

      overlayState = {
        ...overlayState,
        message: newMessage,
      };
      render();
    },
    updateProgress: ({ progress = overlayState.progress, message = overlayState.message, detail = overlayState.detail }) => {
      if (isDestroyed) {
        return;
      }

      overlayState = {
        ...overlayState,
        progress,
        message,
        detail,
      };
      render();
    },
    destroy: () => {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      root.unmount();
      if (document.body.contains(container)) {
        document.body.removeChild(container);
      }
    }
  };
};

/**
 * Lightweight pure-DOM loading overlay (no React, no canvas, no dynamic imports).
 * The React-based createLoadingOverlay above renders LoadingIndicator, whose mount/unmount and
 * dynamic-import animation setup can wedge the main thread when it's created/updated/torn down
 * around an in-flight download. This drop-in replacement (same updateProgress/destroy API) is just
 * a CSS-spinner div, so it can never block the download flow.
 * @param {string} message - Initial loading message
 */
export const createSimpleLoadingOverlay = (message) => {
  if (!document.getElementById('osg-simple-overlay-style')) {
    const style = document.createElement('style');
    style.id = 'osg-simple-overlay-style';
    style.textContent = '@keyframes osg-spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
  }

  const container = document.createElement('div');
  container.style.cssText = [
    'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
    'padding:24px 32px', 'background:rgba(0,0,0,0.85)', 'border-radius:16px', 'z-index:9999',
    'text-align:center', 'box-shadow:0 8px 32px rgba(0,0,0,0.3)', 'min-width:260px',
    'backdrop-filter:blur(8px)', 'color:#fff', 'font-size:15px', 'line-height:1.4',
  ].join(';');

  const spinner = document.createElement('div');
  spinner.style.cssText = [
    'width:32px', 'height:32px', 'margin:0 auto 14px',
    'border:3px solid rgba(255,255,255,0.22)', 'border-top-color:#60a5fa',
    'border-radius:50%', 'animation:osg-spin 0.8s linear infinite',
  ].join(';');

  const msgEl = document.createElement('div');
  msgEl.textContent = message || '';

  container.appendChild(spinner);
  container.appendChild(msgEl);
  document.body.appendChild(container);

  let destroyed = false;
  return {
    container,
    updateProgress: ({ message: m } = {}) => {
      if (!destroyed && typeof m === 'string') msgEl.textContent = m;
    },
    updateMessage: (m) => {
      if (!destroyed && typeof m === 'string') msgEl.textContent = m;
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
};
