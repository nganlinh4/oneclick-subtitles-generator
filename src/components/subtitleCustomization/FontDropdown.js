import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { groupFontsByCategory, getFontSupportFlags, getFontSampleText } from './fontOptions';
import '../../styles/subtitle-customization/FontDropdown.css';

const FontDropdown = ({ value, onChange, className }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const dropdownRef = useRef(null);
  const searchInputRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
        setSearchTerm('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  const groupedFonts = groupFontsByCategory();

  // Filter fonts based on search term
  const filteredGroups = Object.entries(groupedFonts).reduce((acc, [group, fonts]) => {
    const filteredFonts = fonts.filter(font =>
      font.label.toLowerCase().includes(searchTerm.toLowerCase()) ||
      font.group.toLowerCase().includes(searchTerm.toLowerCase())
    );
    if (filteredFonts.length > 0) {
      acc[group] = filteredFonts;
    }
    return acc;
  }, {});

  // Find current font for display
  const currentFont = Object.values(groupedFonts)
    .flat()
    .find(font => font.value === value);

  const handleFontSelect = (fontValue) => {
    onChange(fontValue);
    setIsOpen(false);
    setSearchTerm('');
  };

  const toggleDropdown = () => {
    setIsOpen(!isOpen);
    if (!isOpen) {
      setSearchTerm('');
    }
  };

  return (
    <div className={`font-dropdown ${className || ''}`} ref={dropdownRef}>
      {/* Selected font display */}
      <div
        className={`font-dropdown-selected ${isOpen ? 'open' : ''}`}
        onClick={toggleDropdown}
      >
        <div className="font-preview">
          <span
            className="font-name"
            style={{ fontFamily: currentFont?.value || value }}
          >
            {currentFont?.label || t('fontModal.selectFont', 'Select Font')}
          </span>
          <span className="font-flags" style={{ fontFamily: currentFont?.value || value }}>
            {currentFont && getFontSupportFlags(currentFont)}
          </span>
        </div>
        <div className="dropdown-arrow">
          {isOpen ? '▲' : '▼'}
        </div>
      </div>

      {/* Dropdown menu */}
      {isOpen && (
        <div className="font-dropdown-menu">
          {/* Search input */}
          <div className="font-search">
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search fonts..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="font-search-input"
            />
          </div>

          {/* Font options */}
          <div className="font-options">
            {Object.entries(filteredGroups).map(([group, fonts]) => (
              <div key={group} className="font-group">
                <div className="font-group-header">{t(`fontModal.category${group}`, group)}</div>
                {fonts.map(font => (
                  <div
                    key={font.value}
                    className={`font-option ${font.value === value ? 'selected' : ''}`}
                    onClick={() => handleFontSelect(font.value)}
                  >
                    <div className="font-option-content">
                      <div
                        className="font-sample"
                        style={{ fontFamily: font.value }}
                      >
                        {getFontSampleText(font)}
                      </div>
                      <div className="font-details" style={{ fontFamily: font.value }}>
                        <span className="font-label">{font.label}</span>
                        <span className="font-flags">
                          {getFontSupportFlags(font)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))}

            {Object.keys(filteredGroups).length === 0 && (
              <div className="no-results">
                No fonts found matching "{searchTerm}"
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default FontDropdown;
