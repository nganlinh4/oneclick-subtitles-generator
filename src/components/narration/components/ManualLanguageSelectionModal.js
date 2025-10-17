import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ISO6391 from 'iso-639-1';
import ReactDOM from 'react-dom';
import CloseButton from '../../common/CloseButton';
import initSettingsTabsDrag from '../../../utils/settingsTabsDrag';
import '../../../styles/narration/ManualLanguageSelectionModal.css';

const ManualLanguageSelectionModal = ({
  isOpen,
  onClose,
  onSave,
  initialLanguages = [],
  subtitleSource
}) => {
  const { t } = useTranslation();
  const [selectedLanguages, setSelectedLanguages] = useState(['']);
  const [recentLanguages, setRecentLanguages] = useState([]);
  const [typingValues, setTypingValues] = useState({});

  // Load recent languages from localStorage and normalize to lowercase valid ISO-639-1 codes
  useEffect(() => {
    const stored = localStorage.getItem('recentlyChosenLanguages');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        const allCodes = new Set(ISO6391.getAllCodes());
        const normalized = (Array.isArray(parsed) ? parsed : [])
          .map(c => (typeof c === 'string' ? c.toLowerCase() : ''))
          .filter(c => c && allCodes.has(c));
        setRecentLanguages(normalized);
      } catch (error) {
        console.error(t('narration.errorParsingRecentLanguages', 'Error parsing recent languages:'), error);
        setRecentLanguages([]);
      }
    }
  }, []);

  // Initialize languages when modal opens
  useEffect(() => {
    if (isOpen) {
      if (initialLanguages.length > 0) {
        setSelectedLanguages([...initialLanguages, '']);
      } else {
        setSelectedLanguages(['']);
      }
      setTypingValues({});
    }
  }, [isOpen, initialLanguages]);

  // Get filtered suggestions based on typing
  const getFilteredSuggestions = (typingValue) => {
    if (!typingValue || typingValue.trim() === '') {
      return [];
    }

    const searchTerm = typingValue.toLowerCase();
    const allCodes = ISO6391.getAllCodes();

    return allCodes.filter(code => {
      const name = ISO6391.getName(code).toLowerCase();
      return name.includes(searchTerm) || code.toLowerCase().includes(searchTerm);
    }).slice(0, 10);
  };

  // Handle typing in input
  const handleTypingChange = (index, value) => {
    setTypingValues(prev => ({
      ...prev,
      [index]: value
    }));
  };

  // Handle language selection
  const handleLanguageSelect = (index, langCode) => {
    const newLanguages = [...selectedLanguages];
    newLanguages[index] = langCode;

    // Clear typing value
    setTypingValues(prev => ({
      ...prev,
      [index]: ''
    }));

    // Add new empty slot if this was the last one
    if (index === selectedLanguages.length - 1) {
      newLanguages.push('');
    }

    setSelectedLanguages(newLanguages);
  };

  // Handle clearing a language
  const handleClearLanguage = (index) => {
    // Remove the language wrapper entirely
    const newLanguages = selectedLanguages.filter((_, i) => i !== index);
    // Ensure there's always an empty slot at the end for adding new languages
    if (newLanguages.length === 0 || newLanguages[newLanguages.length - 1] !== '') {
      newLanguages.push('');
    }
    setSelectedLanguages(newLanguages);
    // Update typing values: remove the cleared index and shift subsequent indices
    setTypingValues(prev => {
      const newTyping = {};
      Object.keys(prev).forEach(key => {
        const keyIndex = parseInt(key);
        if (keyIndex < index) {
          newTyping[keyIndex] = prev[key];
        } else if (keyIndex > index) {
          newTyping[keyIndex - 1] = prev[key];
        }
        // Skip the cleared index
      });
      return newTyping;
    });
  };



  // Save languages
  const handleSave = () => {
    const validLanguages = selectedLanguages.filter(lang => 
      lang && typeof lang === 'string' && lang.trim() !== ''
    );
    const uniqueLanguages = [...new Set(validLanguages)];

    // Save to recent languages
    if (uniqueLanguages.length > 0) {
      const updatedRecent = [
        ...uniqueLanguages,
        ...recentLanguages.filter(lang => !uniqueLanguages.includes(lang))
      ];

      setRecentLanguages(updatedRecent);
      localStorage.setItem('recentlyChosenLanguages', JSON.stringify(updatedRecent));
    }

    onSave(uniqueLanguages);
    onClose();
  };

  // Handle close
  const handleClose = () => {
    setSelectedLanguages(['']);
    setTypingValues({});
    onClose();
  };

  // Handle outside clicks and escape key
  useEffect(() => {
    const handleEscKey = (event) => {
      if (event.key === 'Escape') {
        handleClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscKey);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscKey);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  // Initialize drag functionality for language suggestions
  useEffect(() => {
    if (isOpen) {
      const cleanup = initSettingsTabsDrag('.language-suggestions');
      return cleanup;
    }
  }, [isOpen]);



  if (!isOpen) return null;

  return ReactDOM.createPortal(
    <div className="language-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className="language-modal" role="dialog" aria-modal="true" tabIndex="-1" onClick={(e) => e.stopPropagation()}>
        <div className="language-modal-header">
          <h2>{t('narration.manualLanguageSelection', 'Manual Language Selection')}</h2>
          <CloseButton onClick={handleClose} variant="modal" size="medium" />
        </div>

        <div className="language-modal-content">
          <div className="manual-language-selection">

            <div className="language-dropdowns-container">
              <div className="language-dropdown-wrapper">
                <div className="selected-languages-container">
                  {selectedLanguages.slice(0, -1).map((language, index) => (
                    <div key={language} className="selected-language-badge">
                      <span>{ISO6391.getName(language)}</span>
                      <button onClick={() => handleClearLanguage(index)} className="clear-language-btn" title={t('narration.clearLanguage', 'Clear this language')}>
                        <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>close</span>
                      </button>
                    </div>
                  ))}
                </div>
                <div className="language-row">
                  <input
                    type="text"
                    value={typingValues[selectedLanguages.length - 1] || ''}
                    onChange={(e) => handleTypingChange(selectedLanguages.length - 1, e.target.value)}
                    placeholder={t('narration.typeLanguage', 'Type language')}
                    className="language-input"
                  />
                  {(typingValues[selectedLanguages.length - 1] || recentLanguages.length > 0) && (
                    <div className="suggestions-wrapper"> {/* <<< Add this wrapper */}
                      <div className="language-suggestions">
                        {typingValues[selectedLanguages.length - 1] ? (
                          getFilteredSuggestions(typingValues[selectedLanguages.length - 1]).map(code => (
                            <button
                              key={code}
                              onClick={() => handleLanguageSelect(selectedLanguages.length - 1, code)}
                              className="suggestion-badge"
                            >
                              {ISO6391.getName(code)}
                            </button>
                          ))
                        ) : (
                          recentLanguages.map(code => (
                            <button
                              key={code}
                              onClick={() => handleLanguageSelect(selectedLanguages.length - 1, code)}
                              className="suggestion-badge recent"
                            >
                              {ISO6391.getName(code)}
                            </button>
                          ))
                        )}
                      </div>
                    </div> 
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="language-modal-footer">
          <div className="language-count">
            {t('narration.selectLanguagesFor', 'Select languages for {{source}} subtitles', {
              source: subtitleSource === 'translated' ? t('narration.translated', 'translated') : t('narration.original', 'original')
            })}
          </div>
          <div className="modal-actions">
            <button className="btn-primary" onClick={handleSave}>
              {t('common.save', 'Save')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ManualLanguageSelectionModal;
