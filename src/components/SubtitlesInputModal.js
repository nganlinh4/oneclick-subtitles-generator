import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import CloseButton from './common/CloseButton';
import CustomScrollbarTextarea from './common/CustomScrollbarTextarea';
import '../styles/SubtitlesInputModal.css';
import LyricsInputSection from './LyricsInputSection';
import MaterialSwitch from './common/MaterialSwitch';
import '../styles/common/material-switch.css';
import HelpIcon from './common/HelpIcon';


/**
 * Modal component for inputting subtitles without timings
 * @param {Object} props - Component props
 * @param {string} props.initialText - Initial text for the textarea
 * @param {Function} props.onSave - Function called when subtitles are saved
 * @param {Function} props.onClose - Function called when modal is closed
 * @returns {JSX.Element} - Rendered component
 */
const SubtitlesInputModal = ({ initialText = '', onSave, onClose, onGenerateBackground }) => {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const textareaRef = useRef(null);
  const [showLyricsInput, setShowLyricsInput] = useState(false);
  const [albumArt, setAlbumArt] = useState('');
  const [showBackgroundPrompt, setShowBackgroundPrompt] = useState(false);
  const [songName, setSongName] = useState('');
  const [isClosing, setIsClosing] = useState(false);
  const [autoEraseBlankLines, setAutoEraseBlankLines] = useState(true);


  // Focus the textarea when the modal opens
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

  const handleSave = () => {
    const finalText = autoEraseBlankLines ? removeBlankLines(text) : text;
    onSave(finalText);
  };

  const handleTextChange = (e) => {
    setText(e.target.value);
  };

  // Utility to remove blank lines
  const removeBlankLines = (s) => s.split('\n').filter(line => line.trim() !== '').join('\n');

  // Handle paste to auto-clean blank lines without disrupting typing
  const handlePaste = (e) => {
    if (!autoEraseBlankLines) return;
    const textarea = e.target;
    const paste = e.clipboardData?.getData('text');
    if (typeof paste !== 'string') return;
    e.preventDefault();
    const cleaned = removeBlankLines(paste);
    const start = textarea.selectionStart ?? text.length;
    const end = textarea.selectionEnd ?? start;
    const newValue = text.slice(0, start) + cleaned + text.slice(end);
    setText(newValue);
    // Restore caret after React updates the value
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = start + cleaned.length;
        textareaRef.current.setSelectionRange(pos, pos);
        textareaRef.current.focus();
      }
    });
  };

  // When enabling auto-erase, proactively clean existing text once and preserve caret
  useEffect(() => {
    if (!autoEraseBlankLines) return;
    setText((prev) => {
      const cleaned = removeBlankLines(prev);
      if (cleaned === prev) return prev;
      const ta = textareaRef.current;
      if (ta) {
        const oldPos = ta.selectionStart ?? 0;
        const before = prev.slice(0, oldPos);
        const beforeCleaned = removeBlankLines(before);
        const newPos = beforeCleaned.length;
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            const pos = Math.min(newPos, cleaned.length);
            textareaRef.current.setSelectionRange(pos, pos);
          }
        });
      }
      return cleaned;
    });
  }, [autoEraseBlankLines]);


  // Handle receiving lyrics from the LyricsInputSection component
  const handleLyricsReceived = (lyrics, albumArtUrl, songTitle) => {
    const cleanedLyrics = autoEraseBlankLines ? removeBlankLines(lyrics) : lyrics;
    setText(cleanedLyrics);
    setAlbumArt(albumArtUrl);
    setSongName(songTitle || '');
    setShowBackgroundPrompt(true);
  };



  // Function to handle closing with animation
  const handleClose = () => {
    // Start the closing animation
    setIsClosing(true);

    // Wait for the animation to complete before actually closing
    setTimeout(() => {
      onClose();
    }, 150); // Match this with the CSS transition duration
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e) => {
    // Ctrl+Enter or Cmd+Enter to save
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    }
    // Escape to close
    else if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
    }
  };

  return (
    <div className={`subtitles-input-modal-overlay ${isClosing ? 'closing' : ''}`}>
      <div className={`subtitles-input-modal ${isClosing ? 'closing' : ''}`}>
        <div className="subtitles-input-modal-header">
          <div className="header-title-section">
            <h2>{t('subtitlesInput.title', 'Add Your Subtitles')}</h2>
          </div>
          <CloseButton onClick={handleClose} variant="modal" size="medium" />
        </div>

        <div className="subtitles-input-modal-content">
          <div className="explanation-example-container">
            <div className="explanation">
              {t('subtitlesInput.explanation',
                'Paste your subtitles here without timings. When you generate subtitles, the system will focus on matching these texts with the audio and creating accurate timings. Each line will be treated as a separate subtitle.')}
            </div>

            <div className="example">
              <h3>{t('subtitlesInput.exampleTitle', 'Example:')}</h3>
              <pre>
                {t('subtitlesInput.example',
                  'Hello, welcome to our tutorial.\nToday we will learn about machine learning.\nLet\'s get started!')}
              </pre>
            </div>
          </div>

          <div className="lyrics-autofill-toggle">
            <button
              className={`lyrics-toggle-button ${showLyricsInput ? 'active' : ''}`}
              onClick={() => setShowLyricsInput(!showLyricsInput)}
              title={t('subtitlesInput.lyricsToggle', 'Toggle lyrics search')}
            >
              <span className="material-symbols-rounded">queue_music</span> {t('subtitlesInput.fetchLyrics', 'Fetch Song Lyrics')}
            </button>
          </div>

          {showLyricsInput && (
            <LyricsInputSection onLyricsReceived={handleLyricsReceived} />
          )}



          {showBackgroundPrompt && albumArt && (
            <div className="background-prompt-message" onClick={() => {






              // First save the text
              onSave(text);

              // Then generate the background
              if (onGenerateBackground) {

                onGenerateBackground(text, albumArt, songName);

              } else {
                console.error('onGenerateBackground function is not available');
              }
            }}>
              <span className="material-symbols-rounded">image</span>
              <span>{t('subtitlesInput.generateBackground', 'Do you want to generate background image inspired from this album art and lyrics?')}</span>
            </div>
          )}

          <CustomScrollbarTextarea
            ref={textareaRef}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={t('subtitlesInput.placeholder', 'Enter your subtitles here...')}
            rows={8}
            containerClassName="large"
          />

          <div className="keyboard-shortcuts">
            <div className="keyboard-shortcuts-left">
              <span>{t('subtitlesInput.keyboardShortcuts', 'Keyboard shortcuts:')}</span>
              <span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> {t('subtitlesInput.toSave', 'to save')}</span>
              <span><kbd>Esc</kbd> {t('subtitlesInput.toCancel', 'to cancel')}</span>
            </div>
            <div className="keyboard-shortcuts-right">
              <span>{t('subtitlesInput.lineCount', 'Đã nhập ??? dòng phụ đề').replace('???', text.trim() ? text.trim().split('\n').length : 0)}</span>
            </div>
          </div>
        </div>

        <div className="subtitles-input-modal-footer">
          <div className="footer-left">
            <div className="material-switch-container">
              <MaterialSwitch
                id="auto-erase-blank-lines"
                checked={autoEraseBlankLines}
                onChange={(e) => setAutoEraseBlankLines(e.target.checked)}
                ariaLabel={t('subtitlesInput.autoEraseBlankLines', 'Auto erase blank lines')}
                icons={true}
              />
              <label htmlFor="auto-erase-blank-lines" className="material-switch-label">
                {t('subtitlesInput.autoEraseBlankLines', 'Auto erase blank lines')}
              </label>
              <HelpIcon title={t('subtitlesInput.autoEraseBlankLinesHelp', 'Automatically remove empty lines from pasted text and existing content. Does not interfere while typing.')} />
            </div>
          </div>
          <div className="footer-right">
            <button className="cancel-button" onClick={handleClose}>
              {t('subtitlesInput.cancel', 'Cancel')}
            </button>
            <button className="save-button" onClick={handleSave}>
              {t('subtitlesInput.save', 'Save Subtitles')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SubtitlesInputModal;
