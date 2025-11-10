import React from 'react';

const SeekIndicator = ({ showSeekIndicator, seekDirection }) => {
  if (!showSeekIndicator) return null;

  return (
    <>
      {/* Seek indicator */}
      <div className={`seek-indicator ${seekDirection}`}>
        <span className="material-symbols-rounded" style={{ fontSize: '120px' }}>
          {seekDirection === 'backward' ? 'fast_rewind' : 'fast_forward'}
        </span>
      </div>

      <style>
        {`
          .seek-indicator {
            position: absolute;
            top: 50%;
            z-index: 20;
            color: white;
            text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
            pointer-events: none;
            animation: fadeInOut 1s ease-in-out;
          }

          .seek-indicator.backward {
            left: 20%;
            transform: translateY(-50%);
          }

          .seek-indicator.forward {
            right: 20%;
            transform: translateY(-50%);
          }

          @keyframes fadeInOut {
            0% { opacity: 0; transform: translateY(-50%) scale(0.8); }
            10% { opacity: 1; transform: translateY(-50%) scale(1); }
            90% { opacity: 1; transform: translateY(-50%) scale(1); }
            100% { opacity: 0; transform: translateY(-50%) scale(0.8); }
          }
        `}
      </style>
    </>
  );
};

export default SeekIndicator;