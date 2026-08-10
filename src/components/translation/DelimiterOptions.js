import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Delimiter options component for multi-language translation
 * @param {Object} props - Component props
 * @param {string} props.selectedDelimiter - Currently selected delimiter
 * @param {Function} props.onDelimiterChange - Function to handle delimiter change
 * @param {boolean} props.useParentheses - Whether to use parentheses
 * @param {Function} props.onParenthesesChange - Function to handle parentheses toggle
 * @param {boolean} props.disabled - Whether the options are disabled
 * @param {boolean} props.showParenthesesOption - Whether to show the parentheses option
 * @returns {JSX.Element} - Rendered component
 */
const DelimiterOptions = ({
  selectedDelimiter,
  onDelimiterChange,
  useParentheses,
  onParenthesesChange,
  disabled = false,
  showParenthesesOption = false
}) => {
  const { t } = useTranslation();

  // Available brackets for single language
  const bracketStyles = [
    { id: 'parentheses', value: ['(', ')'], label: '( )' },
    { id: 'square', value: ['[', ']'], label: '[ ]' },
    { id: 'curly', value: ['{', '}'], label: '{ }' },
    { id: 'angle', value: ['<', '>'], label: '< >' },
    { id: 'custom', value: ['', ''], label: '✎' }
  ];

  // Get saved bracket style from localStorage
  const getSavedBracketStyle = () => {
    try {
      const savedStyle = localStorage.getItem('bracketStyle');
      if (savedStyle) {
        const parsedStyle = JSON.parse(savedStyle);
        // Check if it matches any predefined style
        const matchedStyle = bracketStyles.find(style =>
          JSON.stringify(style.value) === JSON.stringify(parsedStyle));
        if (matchedStyle) {
          return { id: matchedStyle.id, isCustom: false };
        }
        // It's a custom style
        return {
          id: 'custom',
          isCustom: true,
          open: parsedStyle[0] || '',
          close: parsedStyle[1] || ''
        };
      }
    } catch (error) {
      console.warn('Error loading bracket style:', error);
    }
    return { id: 'parentheses', isCustom: false };
  };

  const savedStyle = getSavedBracketStyle();
  const [selectedBracketStyle, setSelectedBracketStyle] = useState(savedStyle.id);
  const [showCustomBracketInput, setShowCustomBracketInput] = useState(savedStyle.isCustom);
  const [customOpenBracket, setCustomOpenBracket] = useState(savedStyle.isCustom ? savedStyle.open : '');
  const [customCloseBracket, setCustomCloseBracket] = useState(savedStyle.isCustom ? savedStyle.close : '');

  const handleBracketStyleChange = (styleId) => {
    if (styleId === 'custom') {
      const newState = !showCustomBracketInput;
      setShowCustomBracketInput(newState);

      // If we're showing the custom input, focus on the first input field
      if (newState) {
        // When activating custom, make sure we set it as the selected style
        setSelectedBracketStyle('custom');
        // Enable parentheses mode
        onParenthesesChange(true);

        setTimeout(() => {
          const customInput = document.querySelector('.custom-bracket-input input');
          if (customInput) customInput.focus();
        }, 0);

        // If we have custom brackets already, save them
        if (customOpenBracket || customCloseBracket) {
          localStorage.setItem('bracketStyle', JSON.stringify([customOpenBracket, customCloseBracket]));
        }
      } else {
        // If we're hiding the custom input, revert to parentheses
        setSelectedBracketStyle('parentheses');
        const style = bracketStyles.find(s => s.id === 'parentheses');
        if (style) {
          onParenthesesChange(true);
          localStorage.setItem('bracketStyle', JSON.stringify(style.value));
        }
      }
    } else {
      setSelectedBracketStyle(styleId);
      setShowCustomBracketInput(false);
      const style = bracketStyles.find(s => s.id === styleId);
      if (style) {
        onParenthesesChange(true);
        localStorage.setItem('bracketStyle', JSON.stringify(style.value));
      }
    }
  };

  const handleCustomBracketChange = (open, close) => {
    setCustomOpenBracket(open);
    setCustomCloseBracket(close);

    // Always update the bracket style, even if empty
    // This ensures the custom option stays selected
    setSelectedBracketStyle('custom');
    onParenthesesChange(true);
    localStorage.setItem('bracketStyle', JSON.stringify([open, close]));
  };

  // Multi-language delimiters
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
    { id: 'custom', value: '', label: '✎' }
  ];

  // Function to get the delimiter ID from a value
  const getDelimiterIdFromValue = (value) => {
    const predefinedDelimiter = delimiters.find(d => d.value === value && d.id !== 'custom');
    return predefinedDelimiter ? predefinedDelimiter.id : 'custom';
  };

  // Get the current delimiter ID
  const currentDelimiterId = getDelimiterIdFromValue(selectedDelimiter);
  const isCustomDelimiter = currentDelimiterId === 'custom';

  // Initialize custom input state based on whether the current delimiter is custom
  const [showCustomInput, setShowCustomInput] = useState(isCustomDelimiter);
  const [customDelimiter, setCustomDelimiter] = useState(isCustomDelimiter ? selectedDelimiter : '');

  const handleCustomDelimiterChange = (e) => {
    const value = e.target.value;
    setCustomDelimiter(value);

    // Always update the delimiter, even if empty
    // This ensures the parent component knows about the change
    const effectiveValue = value || ' '; // Default to space if empty
    onDelimiterChange(effectiveValue);

    // If the value is empty and we're using a custom delimiter,
    // we should switch to a predefined delimiter (space)
    if (!value) {
      setTimeout(() => {
        // This ensures we update the UI after the state has been updated
        if (getDelimiterIdFromValue(effectiveValue) !== 'custom') {
          setShowCustomInput(false);
        }
      }, 0);
    }
  };

  return (
    <div className="translation-row delimiter-row">
      <div className="row-label">
        <label>{t('translation.delimiterSettings', 'Delimiter Settings')}:</label>
      </div>
      <div className="row-content">
        <div className="delimiter-options">
          {/* Show bracket styles when in dual language mode */}
          {showParenthesesOption && (
            <>
              <div className="bracket-styles">
                {bracketStyles.map(style => (
                  <button
                    key={style.id}
                    className={`delimiter-pill bracket-pill ${showCustomBracketInput && style.id === 'custom' ? 'active' : (!showCustomBracketInput && selectedBracketStyle === style.id ? 'active' : '')}`}
                    onClick={() => handleBracketStyleChange(style.id)}
                    disabled={disabled}
                    title={t(`translation.bracketStyle${style.id.charAt(0).toUpperCase() + style.id.slice(1)}`, style.label)}
                  >
                    {style.label}
                  </button>
                ))}
              </div>

              {showCustomBracketInput && (
                <div className="custom-bracket-input">
                  <input
                    type="text"
                    value={customOpenBracket}
                    onChange={(e) => handleCustomBracketChange(e.target.value, customCloseBracket)}
                    placeholder={t('translation.openBracketPlaceholder', 'Opening bracket')}
                    disabled={disabled}
                    maxLength={5}
                  />
                  <input
                    type="text"
                    value={customCloseBracket}
                    onChange={(e) => handleCustomBracketChange(customOpenBracket, e.target.value)}
                    placeholder={t('translation.closeBracketPlaceholder', 'Closing bracket')}
                    disabled={disabled}
                    maxLength={5}
                  />
                </div>
              )}
            </>
          )}

          {/* Show delimiter pills for all cases - always visible for 2 languages */}
          <div className="delimiter-pills">
            {delimiters.map(delimiter => (
              <button
                key={delimiter.id}
                className={`delimiter-pill ${showCustomInput && delimiter.id === 'custom' ? 'active' : (!showCustomInput && delimiter.id === currentDelimiterId ? 'active' : '')} ${delimiter.id === 'custom' ? 'custom-delimiter' : ''}`}
                onClick={() => {
                  if (delimiter.id === 'custom') {
                    const newShowCustomInput = !showCustomInput;
                    setShowCustomInput(newShowCustomInput);

                    if (newShowCustomInput) {
                      // If we're showing the custom input, focus on it and use the current custom value
                      setTimeout(() => {
                        const customInput = document.querySelector('.custom-delimiter-input input');
                        if (customInput) customInput.focus();
                      }, 0);

                      // If we already have a custom delimiter, use it
                      if (customDelimiter) {
                        onDelimiterChange(customDelimiter);
                      }
                    } else {
                      // If we're hiding the custom input, switch to space delimiter
                      onDelimiterChange(' ');
                    }
                  } else {
                    // When selecting a predefined delimiter, hide custom input
                    onDelimiterChange(delimiter.value);
                    setShowCustomInput(false);
                    // Don't disable brackets when in dual language mode
                    if (useParentheses && !showParenthesesOption) onParenthesesChange(false);
                  }
                }}
                disabled={disabled}
                title={t(`translation.delimiter${delimiter.id.charAt(0).toUpperCase() + delimiter.id.slice(1)}`, delimiter.label)}
              >
                {delimiter.label}
              </button>
            ))}
          </div>

          {/* Custom delimiter input - positioned closer to pills */}
          {showCustomInput && (
            <div className="custom-delimiter-input">
              <input
                type="text"
                value={customDelimiter}
                onChange={handleCustomDelimiterChange}
                placeholder={t('translation.customDelimiterPlaceholder', 'Enter custom delimiter')}
                disabled={disabled}
                maxLength={10}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DelimiterOptions;
