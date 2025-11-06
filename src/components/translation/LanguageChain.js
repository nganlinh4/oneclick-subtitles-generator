import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import Tooltip from '../common/Tooltip';
import '../../styles/translation/languageChain.css';

/**
 * Language Chain component - a chain-line UI for language and delimiter configuration
 * @param {Object} props - Component props
 * @param {Array} props.chainItems - Array of chain items (languages and delimiters)
 * @param {Function} props.onAddLanguage - Function to add a language
 * @param {Function} props.onAddOriginalLanguage - Function to add the original language
 * @param {Function} props.onAddDelimiter - Function to add a delimiter
 * @param {Function} props.onRemoveItem - Function to remove an item
 * @param {Function} props.onUpdateLanguage - Function to update a language
 * @param {Function} props.onUpdateDelimiter - Function to update a delimiter
 * @param {Function} props.onMoveItem - Function to move an item
 * @param {boolean} props.disabled - Whether the chain is disabled
 * @param {boolean} props.showOriginalOption - Whether to show the option to add the original language
 * @returns {JSX.Element} - Rendered component
 */
const LanguageChain = ({
  chainItems,
  onAddLanguage,
  onAddOriginalLanguage,
  onAddDelimiter,
  onRemoveItem,
  onUpdateLanguage,
  onUpdateDelimiter,
  onMoveItem,
  disabled = false,
  showOriginalOption = true
}) => {
  const { t } = useTranslation();
  const [activeDelimiter, setActiveDelimiter] = useState(null);
  const [draggedItem, setDraggedItem] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const chainRef = useRef(null);
  // Refs to avoid stale closures during touch drag
  const draggedItemRef = useRef(null);
  const dropTargetRef = useRef(null);

  // Available delimiters
  const delimiters = [
    { id: 'space', value: ' ', label: '⎵' },
    { id: 'newline', value: '\n', label: '↵' },
    { id: 'slash', value: ' / ', label: '/' },
    { id: 'pipe', value: ' | ', label: '|' },
    { id: 'dash', value: ' - ', label: '-' },
    { id: 'colon', value: ' : ', label: ':' },
    { id: 'semicolon', value: ' ; ', label: ';' },
    { id: 'comma', value: ', ', label: ',' },
    { id: 'dot', value: '. ', label: '.' },
    { id: 'arrow', value: ' → ', label: '→' },
    { id: 'doubleArrow', value: ' ⇒ ', label: '⇒' },
    { id: 'bullet', value: ' • ', label: '•' },
    // Simple bracket options
    { id: 'openParen', value: '(', label: '(' },
    { id: 'closeParen', value: ')', label: ')' },
    { id: 'openSquare', value: '[', label: '[' },
    { id: 'closeSquare', value: ']', label: ']' },
    { id: 'openCurly', value: '{', label: '{' },
    { id: 'closeCurly', value: '}', label: '}' },
    { id: 'openAngle', value: '<', label: '<' },
    { id: 'closeAngle', value: '>', label: '>' }
  ];

  // Add ESC key handler to close the modal
  useEffect(() => {
    const handleEscKey = (event) => {
      if (event.key === 'Escape' && activeDelimiter !== null) {
        setActiveDelimiter(null);
      }
    };

    document.addEventListener('keydown', handleEscKey);
    return () => {
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [activeDelimiter]);

  // Handle drag start
  const handleDragStart = (e, index) => {
    if (disabled) return;

    setDraggedItem(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index);

    // Add a delay to set the drag image
    setTimeout(() => {
      const draggedElement = document.querySelector(`.chain-item[data-index="${index}"]`);
      if (draggedElement) {
        draggedElement.classList.add('dragging');
      }
    }, 0);
  };

  // Handle drag over
  const handleDragOver = (e, index) => {
    e.preventDefault();
    if (draggedItem === index) return;

    setDropTarget(index);
    e.dataTransfer.dropEffect = 'move';
  };

  // Handle drag end
  const handleDragEnd = () => {
    const draggedElement = document.querySelector('.chain-item.dragging');
    if (draggedElement) {
      draggedElement.classList.remove('dragging');
    }

    setDraggedItem(null);
    setDropTarget(null);
  };

  // Handle drop
  const handleDrop = (e, index) => {
    e.preventDefault();
    if (draggedItem === null || draggedItem === index) {
      setDropTarget(null);
      return;
    }

    onMoveItem(draggedItem, index);
    setDraggedItem(null);
    setDropTarget(null);
  };

  // Toggle delimiter dropdown
  const toggleDelimiterDropdown = (id, event) => {
    if (disabled) return;

    // If we're closing the dropdown
    if (activeDelimiter === id) {
      setActiveDelimiter(null);
      return;
    }

    // If we're opening the dropdown, set the active delimiter
    setActiveDelimiter(id);
  };

  // Handle delimiter selection
  const handleDelimiterSelect = (item, delimiterOption) => {
    if (disabled) return;

    onUpdateDelimiter(item.id, delimiterOption.value);
    setActiveDelimiter(null);
  };

  // Handle custom delimiter change
  const handleCustomDelimiterChange = (item, value) => {
    if (disabled) return;
    onUpdateDelimiter(item.id, value);
  };

  // Get delimiter display value
  const getDelimiterDisplay = (delimiter) => {
    // If it's a regular delimiter
    if (!delimiter.value) return '';

    switch (delimiter.value) {
      case ' ': return '⎵';
      case '\n': return '↵';
      default: return delimiter.value.trim();
    }
  };

  // Check if original language is already in the chain
  const hasOriginalLanguage = chainItems.some(item =>
    item.type === 'language' && item.isOriginal
  );

  // Prevent form submission
  const handleFormSubmit = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      return false;
    }
  };

  return (
    <div
      className="language-chain-container"
      ref={chainRef}
      onKeyDown={handleFormSubmit}>
      <div className="language-chain">
        {chainItems.map((item, index) => {
          const placeholderText = item.isOriginal
            ? t('translation.originalLanguage', 'Original')
            : t('translation.languagePlaceholder', 'Target language');
          const tooltipText = item.isOriginal
            ? t('translation.originalLanguage', 'Original')
            : t('translation.languagePlaceholderTooltip', 'Enter a target language here (e.g., English, Romanized Korean, or Japanese, ...)');

          return (
            <div
              key={item.id}
              className={`chain-item ${item.type}-item ${item.isOriginal ? 'original' : ''} ${draggedItem === index ? 'dragging' : ''} ${dropTarget === index ? 'drag-over' : ''}`}
              draggable={!disabled}
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragEnd={handleDragEnd}
              onDrop={(e) => handleDrop(e, index)}
              onTouchStart={(e) => {
                // Simulate drag start for touch devices by tracking start index
                if (disabled) return;
                e.preventDefault();
                e.stopPropagation();
                setDraggedItem(index);
                setDropTarget(index);
                draggedItemRef.current = index;
                dropTargetRef.current = index;
                e.currentTarget.classList.add('dragging');

                const startTarget = e.currentTarget;
                const handleTouchMove = (te) => {
                  const touch = te.touches && te.touches[0];
                  if (!touch) return;
                  // Determine closest chain-item under finger to show drop target
                  const el = document.elementFromPoint(touch.clientX, touch.clientY);
                  const container = chainRef.current;
                  if (!container) return;
                  const chainItemEl = el && (el.closest && el.closest('.chain-item'));
                  if (chainItemEl && container.contains(chainItemEl)) {
                    const targetIndex = parseInt(chainItemEl.getAttribute('data-index'), 10);
                    if (!isNaN(targetIndex) && targetIndex !== dropTargetRef.current) {
                      setDropTarget(targetIndex);
                      dropTargetRef.current = targetIndex;
                    }
                  }
                  te.preventDefault();
                };
                const handleTouchEnd = () => {
                  document.removeEventListener('touchmove', handleTouchMove);
                  document.removeEventListener('touchend', handleTouchEnd);
                  document.removeEventListener('touchcancel', handleTouchEnd);
                  // Commit move if indices are valid, using refs to avoid stale closure
                  const fromIndex = draggedItemRef.current;
                  const toIndex = dropTargetRef.current;
                  if (fromIndex !== null && toIndex !== null && fromIndex !== toIndex) {
                    onMoveItem(fromIndex, toIndex);
                  }
                  // Cleanup classes and state
                  startTarget.classList.remove('dragging');
                  setDraggedItem(null);
                  setDropTarget(null);
                  draggedItemRef.current = null;
                  dropTargetRef.current = null;
                };
                document.addEventListener('touchmove', handleTouchMove, { passive: false });
                document.addEventListener('touchend', handleTouchEnd);
                document.addEventListener('touchcancel', handleTouchEnd);
              }}
              style={{ touchAction: 'none' }}
              data-index={index}
            >
              {item.type === 'language' ? (
                // Language item
                <Tooltip content={tooltipText}>
                  <>
                    <input
                      type="text"
                      value={item.value}
                      onChange={(e) => onUpdateLanguage(item.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                        }
                      }}
                      placeholder={placeholderText}
                      disabled={disabled || item.isOriginal}
                    />
                    <button
                      type="button"
                      className="remove-btn"
                      onClick={(e) => {
                        e.preventDefault();
                        onRemoveItem(item.id);
                      }}
                      disabled={disabled}
                      title={t('translation.removeLanguage', 'Remove')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: '12px' }}>close</span>
                    </button>
                  </>
                </Tooltip>
              ) : (
                // Delimiter item
                <>
                  <div
                    className={`delimiter-display ${activeDelimiter === item.id ? 'active' : ''}`}
                    onClick={(e) => toggleDelimiterDropdown(item.id, e)}
                  >
                    {getDelimiterDisplay(item)}
                  </div>
                  <button
                    type="button"
                    className="remove-btn remove-delimiter-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      onRemoveItem(item.id);
                    }}
                    disabled={disabled}
                    title={t('translation.removeDelimiter', 'Remove delimiter')}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: '10px' }}>close</span>
                  </button>

                  {/* Render the modal using createPortal to ensure it's at the root level */}
                  {activeDelimiter === item.id && createPortal(
                    <div className="delimiter-modal-overlay" onClick={() => setActiveDelimiter(null)}>
                      <div className="delimiter-dropdown" onClick={(e) => e.stopPropagation()}>
                        {delimiters.map(delimiterOption => (
                          <button
                            type="button"
                            key={delimiterOption.id}
                            className={`delimiter-option ${item.value === delimiterOption.value ? 'active' : ''}`}
                            onClick={(e) => {
                              e.preventDefault();
                              handleDelimiterSelect(item, delimiterOption);
                            }}
                            title={t(`translation.delimiter${delimiterOption.id.charAt(0).toUpperCase() + delimiterOption.id.slice(1)}`, delimiterOption.label)}
                          >
                            {delimiterOption.label}
                          </button>
                        ))}

                        {/* Custom delimiter input */}
                        <div className="delimiter-custom-input">
                          <input
                            type="text"
                            value={item.value}
                            onChange={(e) => handleCustomDelimiterChange(item, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                              }
                            }}
                            placeholder={t('translation.customDelimiterPlaceholder', 'Enter custom delimiter')}
                            disabled={disabled}
                            maxLength={10}
                          />
                        </div>
                      </div>
                    </div>,
                    document.body
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="chain-actions">
        <button
          type="button"
          className="add-chain-item-btn"
          onClick={(e) => {
            e.preventDefault();
            onAddLanguage();
          }}
          disabled={disabled}
        >
          <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>add</span>
          {t('translation.addLanguage', 'Add Language')}
        </button>

        <button
          type="button"
          className="add-chain-item-btn delimiter"
          onClick={(e) => {
            e.preventDefault();
            // Add a new delimiter at the end of the chain
            const newDelimiter = {
              id: Date.now(),
              type: 'delimiter',
              value: ' ' // Default to space
            };
            onAddDelimiter(newDelimiter);
          }}
          disabled={disabled}
        >
          <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>align_justify_space_between</span>
          {t('translation.addDelimiter', 'Add Delimiter')}
        </button>

        {showOriginalOption && !hasOriginalLanguage && (
          <button
            type="button"
            className="add-chain-item-btn original"
            onClick={(e) => {
              e.preventDefault();
              onAddOriginalLanguage();
            }}
            disabled={disabled}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="16"></line>
              <line x1="8" y1="12" x2="16" y2="12"></line>
            </svg>
            {t('translation.addOriginalLanguage', 'Add Original')}
          </button>
        )}
      </div>
    </div>
  );
};

export default LanguageChain;
