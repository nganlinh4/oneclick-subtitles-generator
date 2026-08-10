/**
 * Streaming Progress Component
 * Shows real-time progress during streaming subtitle generation
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

const StreamingProgress = ({ 
  isStreaming = false, 
  chunkCount = 0, 
  subtitleCount = 0, 
  textLength = 0,
  className = '' 
}) => {
  const { t } = useTranslation();
  const [dots, setDots] = useState('');

  // Animate dots for streaming indicator
  useEffect(() => {
    if (!isStreaming) {
      setDots('');
      return;
    }

    const interval = setInterval(() => {
      setDots(prev => {
        if (prev.length >= 3) return '';
        return prev + '.';
      });
    }, 500);

    return () => clearInterval(interval);
  }, [isStreaming]);

  if (!isStreaming && chunkCount === 0) {
    return null;
  }

  return (
    <div className={`streaming-progress ${className}`}>
      <div className="streaming-status">
        {isStreaming ? (
          <div className="streaming-active">
            <div className="streaming-indicator">
              <div className="pulse-dot"></div>
              <span className="streaming-text">
                {t('streaming.processing', 'Streaming response')}
                <span className="dots">{dots}</span>
              </span>
            </div>
          </div>
        ) : (
          <div className="streaming-complete">
            <span className="complete-icon">✓</span>
            <span>{t('streaming.complete', 'Streaming complete')}</span>
          </div>
        )}
      </div>

      <div className="streaming-stats">
        <div className="stat-item">
          <span className="stat-label">{t('streaming.chunks', 'Chunks')}:</span>
          <span className="stat-value">{chunkCount}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">{t('streaming.subtitles', 'Subtitles')}:</span>
          <span className="stat-value">{subtitleCount}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">{t('streaming.textLength', 'Text')}:</span>
          <span className="stat-value">{(textLength / 1000).toFixed(1)}k</span>
        </div>
      </div>

      <style jsx>{`
        .streaming-progress {
          background: rgba(0, 0, 0, 0.05);
          border-radius: 8px;
          padding: 12px;
          margin: 8px 0;
          border-left: 4px solid #007bff;
        }

        .streaming-status {
          margin-bottom: 8px;
        }

        .streaming-active {
          display: flex;
          align-items: center;
        }

        .streaming-indicator {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .pulse-dot {
          width: 8px;
          height: 8px;
          background: #007bff;
          border-radius: 50%;
          animation: pulse 1.5s infinite;
        }

        @keyframes pulse {
          0% {
            transform: scale(1);
            opacity: 1;
          }
          50% {
            transform: scale(1.2);
            opacity: 0.7;
          }
          100% {
            transform: scale(1);
            opacity: 1;
          }
        }

        .streaming-text {
          font-weight: 500;
          color: #007bff;
        }

        .dots {
          display: inline-block;
          width: 20px;
          text-align: left;
        }

        .streaming-complete {
          display: flex;
          align-items: center;
          gap: 8px;
          color: #28a745;
          font-weight: 500;
        }

        .complete-icon {
          font-size: 16px;
        }

        .streaming-stats {
          display: flex;
          gap: 16px;
          font-size: 0.85em;
          color: #666;
        }

        .stat-item {
          display: flex;
          gap: 4px;
        }

        .stat-label {
          font-weight: 500;
        }

        .stat-value {
          color: #007bff;
          font-weight: 600;
        }

        /* Dark theme support */
        @media (prefers-color-scheme: dark) {
          .streaming-progress {
            background: rgba(255, 255, 255, 0.05);
            border-left-color: #0d6efd;
          }

          .pulse-dot {
            background: #0d6efd;
          }

          .streaming-text {
            color: #0d6efd;
          }

          .streaming-complete {
            color: #198754;
          }

          .streaming-stats {
            color: #adb5bd;
          }

          .stat-value {
            color: #0d6efd;
          }
        }
      `}</style>
    </div>
  );
};

export default StreamingProgress;
