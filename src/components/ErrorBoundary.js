import React from 'react';
import i18n from '../i18n/i18n';

/**
 * Top-level error boundary: a single unhandled render error degrades to a recoverable message
 * instead of white-screening the entire app (React unmounts the whole tree on an uncaught throw).
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Unhandled render error:', error, info && info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const message = String(
      (this.state.error && this.state.error.message) || this.state.error || 'Unknown error'
    );

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          padding: '2rem',
          textAlign: 'center',
          fontFamily: 'system-ui, sans-serif',
          color: '#e0e0e0',
          background: '#1a1a1a',
          gap: '1rem',
        }}
      >
        <h2 style={{ margin: 0 }}>{i18n.t('errors.somethingWentWrong', 'Something went wrong')}</h2>
        <p style={{ maxWidth: 480, opacity: 0.8 }}>
          {i18n.t('errors.unexpectedErrorReload', 'The interface hit an unexpected error. Reloading usually fixes it.')}
        </p>
        <pre
          style={{
            maxWidth: 600,
            maxHeight: 160,
            overflow: 'auto',
            fontSize: 12,
            opacity: 0.6,
            background: '#111',
            padding: '0.75rem',
            borderRadius: 8,
            textAlign: 'left',
          }}
        >
          {message}
        </pre>
        <button
          onClick={this.handleReload}
          style={{
            padding: '0.6rem 1.4rem',
            fontSize: 15,
            borderRadius: 8,
            border: 'none',
            cursor: 'pointer',
            background: '#4f8cff',
            color: '#fff',
          }}
        >
          {i18n.t('common.reload', 'Reload')}
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
