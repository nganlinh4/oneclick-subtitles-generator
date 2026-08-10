import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import CloseButton from '../common/CloseButton';

/**
 * Simple Narration Menu - A simplified version of the narration playback menu
 * @returns {JSX.Element} - Rendered component
 */
const SimpleNarrationMenu = () => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  // Toggle menu open/closed
  const toggleMenu = () => {
    setIsOpen(!isOpen);
  };

  // Close menu
  const closeMenu = () => {
    setIsOpen(false);
  };

  return (
    <div style={{ position: 'absolute', left: '-50px', top: '0', zIndex: 1000 }}>
      {/* Toggle Button */}
      <button
        onClick={toggleMenu}
        style={{
          width: '40px',
          height: '40px',
          backgroundColor: isOpen ? '#1565C0' : '#2196F3',
          color: 'white',
          border: 'none',
          borderRadius: '8px',
          cursor: 'pointer',
          fontSize: '20px',
          fontWeight: 'bold',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        N
      </button>

      {/* Menu Panel */}
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            left: '50px',
            top: '0',
            width: '300px',
            backgroundColor: 'white',
            border: '1px solid #ccc',
            borderRadius: '8px',
            boxShadow: '0 4px 8px rgba(0,0,0,0.2)',
            zIndex: 9999,
            padding: '16px'
          }}
        >
          {/* Menu Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3 style={{ margin: 0 }}>{t('narration.playbackTitle', 'Narration')}</h3>
            <CloseButton onClick={closeMenu} variant="default" size="small" />
          </div>

          {/* Menu Content */}
          <div>
            <p>This is a simplified narration menu.</p>
            <p>It demonstrates the basic open/close functionality.</p>
          </div>

          {/* Close Button */}
          <button
            onClick={closeMenu}
            style={{
              width: '100%',
              padding: '10px',
              backgroundColor: '#f44336',
              color: 'white',
              border: 'none',
              borderRadius: '20px',
              marginTop: '16px',
              cursor: 'pointer',
              fontSize: '16px',
              fontWeight: 'bold'
            }}
          >
            {t('narration.closeMenu', 'Close Menu')}
          </button>
        </div>
      )}
    </div>
  );
};

export default SimpleNarrationMenu;
