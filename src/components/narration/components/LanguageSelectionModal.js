import React, { useState, useRef, useEffect, useCallback } from 'react';
import { getName } from 'iso-639-1';
import CloseButton from '../../common/CloseButton';
import CustomDropdown from '../../common/CustomDropdown';
import '../../../styles/narration/VoiceSelectionModal.css'; // Reuse the same CSS

const LanguageSelectionModal = ({ isOpen, onClose, languages, selectedLanguage, onLanguageSelect, detectedLanguage, t }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [modalHeight, setModalHeight] = useState('auto');
  const modalRef = useRef(null);
  const searchInputRef = useRef(null);
  const contentRef = useRef(null);

  // Calculate and set modal height for smooth transitions
  const updateModalHeight = useCallback(() => {
    if (modalRef.current && contentRef.current && isOpen) {
      // Get the natural height of the content
      const modalElement = modalRef.current;
      const currentHeight = modalElement.offsetHeight;
      
      // Temporarily set to auto to measure natural height
      modalElement.style.height = 'auto';
      const naturalHeight = modalElement.offsetHeight;
      
      // Set back to current height immediately (no visual change)
      modalElement.style.height = `${currentHeight}px`;
      
      // Force a reflow by reading offsetHeight
      // eslint-disable-next-line no-unused-expressions
      void modalElement.offsetHeight;
      
      // Now transition to the new height
      modalElement.style.height = `${naturalHeight}px`;
    }
  }, [isOpen]);

  // Focus search input when modal opens
  useEffect(() => {
    if (isOpen) {
      if (searchInputRef.current) {
        searchInputRef.current.focus();
      }
      // Set initial height on open
      setTimeout(() => {
        if (modalRef.current) {
          modalRef.current.style.height = 'auto';
          const height = modalRef.current.offsetHeight;
          modalRef.current.style.height = `${height}px`;
        }
      }, 50);
    }
  }, [isOpen]);
  
  // Update height when content changes
  useEffect(() => {
    if (isOpen) {
      // Small delay to let DOM update
      const timer = setTimeout(() => {
        updateModalHeight();
      }, 10);
      return () => clearTimeout(timer);
    }
  }, [searchTerm, selectedCategory, isOpen, updateModalHeight]);

  // Handle click outside modal and ESC key
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modalRef.current && !modalRef.current.contains(event.target)) {
        onClose();
      }
    };

    const handleEscKey = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscKey);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscKey);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  // Get recommended language based on detected language
  const getRecommendedLanguage = () => {
    if (!detectedLanguage?.languageCode) return null;

    return languages.find(lang => lang.code === detectedLanguage.languageCode);
  };

  // Get other languages (not recommended)
  const getOtherLanguages = () => {
    if (!detectedLanguage?.languageCode) return languages;

    return languages.filter(lang => lang.code !== detectedLanguage.languageCode);
  };

  // Get filtered recommended language
  const getFilteredRecommendedLanguage = () => {
    const recommendedLanguage = getRecommendedLanguage();
    if (!recommendedLanguage || (selectedCategory !== 'All' && selectedCategory !== 'Recommended')) {
      return null;
    }

    const matchesSearch = getLanguageName(recommendedLanguage.code).toLowerCase().includes(searchTerm.toLowerCase()) ||
                          recommendedLanguage.code.toLowerCase().includes(searchTerm.toLowerCase());

    return matchesSearch ? recommendedLanguage : null;
  };

  // Get filtered other languages
  const getFilteredOtherLanguages = () => {
    return getOtherLanguages().filter(language =>
      getLanguageName(language.code).toLowerCase().includes(searchTerm.toLowerCase()) ||
      language.code.toLowerCase().includes(searchTerm.toLowerCase())
    ).sort((a, b) => getLanguageName(a.code).localeCompare(getLanguageName(b.code)));
  };

  const handleLanguageSelect = (language) => {
    onLanguageSelect(language.code);
    onClose();
  };

  const clearSearch = () => {
    setSearchTerm('');
    setSelectedCategory('All');
  };

  // Get language name from ISO code
  const getLanguageName = (code) => {
    return getName(code.toLowerCase()) || code;
  };

  // Group filtered other languages by first letter of full name
  const groupedLanguages = getFilteredOtherLanguages().reduce((acc, language) => {
    const firstLetter = getLanguageName(language.code)[0].toUpperCase();
    if (!acc[firstLetter]) {
      acc[firstLetter] = [];
    }
    acc[firstLetter].push(language);
    return acc;
  }, {});

  // Filter groups based on selected category
  const visibleGroupedLanguages = Object.entries(groupedLanguages).filter(([letter]) => {
    if (selectedCategory === 'All' || selectedCategory === 'Recommended') return true;
    return letter === selectedCategory;
  });

  // Get unique categories (All, Recommended, and alphabet letters)
  const availableCategories = [
    'All',
    ...(detectedLanguage?.languageCode ? ['Recommended'] : []),
    ...Object.keys(groupedLanguages).sort()
  ];

  if (!isOpen) return null;

  return (
    <div className="voice-modal-overlay">
      <div className="voice-modal" ref={modalRef} style={{ height: modalHeight }}>
        {/* Modal Header */}
        <div className="voice-modal-header">
          <h2>{t('narration.selectLanguage', 'Select Language')}</h2>
          <div className="voice-count">
            {t('narration.languagesAvailable', '{{count}} languages available', {
              count: (getFilteredRecommendedLanguage() ? 1 : 0) + visibleGroupedLanguages.flatMap(([_, list]) => list).length
            })}
          </div>
          <CloseButton onClick={onClose} variant="modal" size="medium" />
        </div>

        {/* Search and Filter Controls */}
        <div className="voice-modal-controls">
          <div className="voice-search-container">
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t('narration.searchLanguages', 'Search languages...')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="voice-search-input"
            />
            {(searchTerm || selectedCategory !== 'All') && (
              <button className="clear-search" onClick={clearSearch}>
                {t('narration.clear', 'Clear')}
              </button>
            )}
          </div>

          <div className="voice-category-filter">
            <CustomDropdown
              value={selectedCategory}
              onChange={(value) => setSelectedCategory(value)}
              options={availableCategories.map(category => ({
                value: category,
                label: category === 'All'
                  ? t('narration.allCategories', 'All')
                  : category === 'Recommended'
                  ? t('narration.recommendedLanguage', 'Recommended for {{language}}', {
                      language: languages.find(lang => lang.code === detectedLanguage?.languageCode)?.name || detectedLanguage?.languageCode
                    })
                  : category
              }))}
              placeholder={t('narration.selectCategory', 'Select Category')}
            />
          </div>
        </div>

        {/* Language Grid */}
        <div className="voice-modal-content" ref={contentRef}>
          {/* Recommended Language Section */}
          {detectedLanguage?.languageCode && getFilteredRecommendedLanguage() && (
            <div className="voice-category-section">
              <h3 className="voice-category-title recommended">
                {t('narration.recommendedLanguage', 'Recommended for {{language}}', {
                  language: getLanguageName(detectedLanguage.languageCode.toLowerCase())
                })}
              </h3>
              <div className="voice-grid">
                <div
                  className={`voice-card ${getFilteredRecommendedLanguage().code === selectedLanguage ? 'selected' : ''}`}
                  onClick={() => handleLanguageSelect(getFilteredRecommendedLanguage())}
                >
                  <div className="voice-info">
                    <span className="voice-name">{getLanguageName(getFilteredRecommendedLanguage().code)}</span>
                    <div className="voice-meta">
                      <span className="voice-locale">{getFilteredRecommendedLanguage().code}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Other Languages Sections */}
          {visibleGroupedLanguages.map(([letter, languageList]) => (
            <div key={letter} className="voice-category-section">
              <h3 className="voice-category-title">{letter}</h3>
              <div className="voice-grid">
                {languageList.map(language => (
                  <div
                    key={language.code}
                    className={`voice-card ${language.code === selectedLanguage ? 'selected' : ''}`}
                    onClick={() => handleLanguageSelect(language)}
                  >
                    <div className="voice-info">
                      <span className="voice-name">{getLanguageName(language.code)}</span>
                      <div className="voice-meta">
                        <span className="voice-locale">{language.code}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* No Results */}
          {!getFilteredRecommendedLanguage() && visibleGroupedLanguages.length === 0 && (
            <div className="no-results">
              <div className="no-results-icon">🔍</div>
              <h3>{t('narration.noLanguagesFound', 'No languages found')}</h3>
              <p>{t('narration.adjustSearch', 'Try adjusting your search terms or category filter.')}</p>
              <button className="clear-filters-btn" onClick={clearSearch}>
                {t('narration.clearFilters', 'Clear Filters')}
              </button>
            </div>
          )}
        </div>


      </div>
    </div>
  );
};

export default LanguageSelectionModal;
