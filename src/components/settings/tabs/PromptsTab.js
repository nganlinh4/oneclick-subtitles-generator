import React, { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import CustomScrollbarTextarea from '../../common/CustomScrollbarTextarea';
import { DEFAULT_TRANSCRIPTION_PROMPT, PROMPT_PRESETS, getUserPromptPresets, saveUserPromptPresets } from '../../../services/geminiService';

const PromptsTab = ({ transcriptionPrompt, setTranscriptionPrompt }) => {
  const { t } = useTranslation();
  const [userPromptPresets, setUserPromptPresets] = useState(getUserPromptPresets());
  const [showAddPresetForm, setShowAddPresetForm] = useState(false);
  const [newPresetTitle, setNewPresetTitle] = useState('');
  const [viewingPreset, setViewingPreset] = useState(null);
  const [targetLanguage, setTargetLanguage] = useState('');
  const textareaRef = useRef(null);

  // Handle selecting a preset
  const handleSelectPreset = (preset, customLanguage = '') => {
    // Check if preset is a string (direct prompt) or an object (preset)
    if (typeof preset === 'string') {
      // If it's a direct prompt string, just set it
      setTranscriptionPrompt(preset);
    } else {
      // If it's the translation preset, replace the target language placeholder
      if (preset.id === 'translate-directly' && customLanguage) {
        // Replace 'TARGET_LANGUAGE' with the custom language in the prompt
        const updatedPrompt = preset.prompt.replace(/TARGET_LANGUAGE/g, customLanguage);
        setTranscriptionPrompt(updatedPrompt);
      } else {
        setTranscriptionPrompt(preset.prompt);
      }
    }
  };

  // Handle adding a new preset
  const handleAddPreset = () => {
    if (!newPresetTitle.trim()) {
      return; // Don't add empty title presets
    }

    const newPreset = {
      id: `user-${Date.now()}`,
      title: newPresetTitle,
      prompt: transcriptionPrompt
    };

    const updatedPresets = [...userPromptPresets, newPreset];
    setUserPromptPresets(updatedPresets);
    saveUserPromptPresets(updatedPresets);

    // Reset form
    setNewPresetTitle('');
    setShowAddPresetForm(false);
  };

  // Handle deleting a preset
  const handleDeletePreset = (presetId) => {
    const updatedPresets = userPromptPresets.filter(preset => preset.id !== presetId);
    setUserPromptPresets(updatedPresets);
    saveUserPromptPresets(updatedPresets);
  };

  return (
    <div className="settings-section prompts-section">

      {/* Preset Viewing Modal - Using Portal to render at root level */}
      {viewingPreset && createPortal(
        <div className="preset-view-modal" onClick={(e) => {
          // Close when clicking outside the content
          if (e.target.className === 'preset-view-modal') {
            setViewingPreset(null);
          }
        }}>
          <div className="preset-view-content">
            <div className="preset-view-header">
              <h3>
                {(viewingPreset.id === 'general' && t('settings.presetGeneralPurpose', 'General purpose')) ||
                 (viewingPreset.id === 'extract-text' && t('settings.presetExtractText', 'Extract text')) ||
                 (viewingPreset.id === 'focus-lyrics' && t('settings.presetFocusLyrics', 'Focus on Lyrics')) ||
                 (viewingPreset.id === 'describe-video' && t('settings.presetDescribeVideo', 'Describe video')) ||
                 (viewingPreset.id === 'translate-directly' && t('settings.presetTranslateDirectly', 'Translate directly')) ||
                 (viewingPreset.id === 'chaptering' && t('settings.presetChaptering', 'Chaptering')) ||
                 (viewingPreset.id === 'diarize-speakers' && t('settings.presetIdentifySpeakers', 'Identify Speakers')) ||
                 viewingPreset.title}
              </h3>
              <button
                className="close-preset-view-btn"
                onClick={() => setViewingPreset(null)}
              >
                &times;
              </button>
            </div>
            <div className="preset-view-body">
              <pre className="preset-full-text">
                {viewingPreset.id === 'translate-directly' && targetLanguage.trim()
                  ? viewingPreset.prompt.replace(/TARGET_LANGUAGE/g, targetLanguage)
                  : viewingPreset.prompt}
              </pre>
            </div>
            <div className="preset-view-footer">
              {viewingPreset.id === 'translate-directly' ? (
                <div className="translation-language-input-modal">
                  <input
                    type="text"
                    placeholder={t('translation.languagePlaceholder', 'Enter target language')}
                    value={targetLanguage}
                    onChange={(e) => setTargetLanguage(e.target.value)}
                    className="target-language-input"
                  />
                  <button
                    className="use-preset-btn"
                    onClick={() => {
                      handleSelectPreset(viewingPreset, targetLanguage);
                      setViewingPreset(null);
                    }}
                    disabled={!targetLanguage.trim()}
                    title={!targetLanguage.trim() ? t('translation.languageRequired', 'Please enter a target language') : ''}
                  >
                    {t('settings.usePreset', 'Use')}
                  </button>
                </div>
              ) : (
                <button
                  className="use-preset-btn"
                  onClick={() => {
                    handleSelectPreset(viewingPreset);
                    setViewingPreset(null);
                  }}
                >
                  {t('settings.usePreset', 'Use')}
                </button>
              )}
              <button
                className="close-btn-secondary"
                onClick={() => setViewingPreset(null)}
              >
                {t('common.close', 'Close')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Prompt Presets */}
      <div className="prompt-presets-section">
        <h4>{t('settings.promptPresets', 'Prompt Presets')}</h4>
        <p className="setting-description">
          {t('settings.promptPresetsDescription', 'Select a preset to quickly use common prompt types. You can also create your own presets.')}
        </p>

        <div className="prompt-presets-container">
          {/* Built-in presets */}
          {PROMPT_PRESETS.map(preset => (
            <div className="prompt-preset-card" key={preset.id}>
              <div className="preset-card-content">
                <h5 className="preset-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {/* Add SVG icon based on preset type */}
                  {preset.id === 'general' && (
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }}>grid_view</span>
                  )}
                  {preset.id === 'extract-text' && (
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }}>article</span>
                  )}
                  {preset.id === 'focus-lyrics' && (
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }}>music_note</span>
                  )}
                  {preset.id === 'describe-video' && (
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }}>videocam</span>
                  )}
                  {preset.id === 'translate-directly' && (
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }}>language</span>
                  )}
                  {preset.id === 'chaptering' && (
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }}>bookmark</span>
                  )}
                  {preset.id === 'diarize-speakers' && (
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }}>group</span>
                  )}
                  {(preset.id === 'general' && t('settings.presetGeneralPurpose', 'General purpose')) ||
                   (preset.id === 'extract-text' && t('settings.presetExtractText', 'Extract text')) ||
                   (preset.id === 'focus-lyrics' && t('settings.presetFocusLyrics', 'Focus on Lyrics')) ||
                   (preset.id === 'describe-video' && t('settings.presetDescribeVideo', 'Describe video')) ||
                   (preset.id === 'translate-directly' && t('settings.presetTranslateDirectly', 'Translate directly')) ||
                   (preset.id === 'chaptering' && t('settings.presetChaptering', 'Chaptering')) ||
                   (preset.id === 'diarize-speakers' && t('settings.presetIdentifySpeakers', 'Identify Speakers')) ||
                   preset.title}
                </h5>
                {preset.id === 'translate-directly' ? (
                  <>
                    <div className="translation-language-input">
                      <input
                        type="text"
                        placeholder={t('translation.languagePlaceholder', 'Enter target language')}
                        value={targetLanguage}
                        onChange={(e) => setTargetLanguage(e.target.value)}
                        className="target-language-input"
                      />
                    </div>
                    {targetLanguage.trim() && (
                      <p className="preset-preview">
                        {preset.prompt.replace(/TARGET_LANGUAGE/g, targetLanguage).substring(0, 60)}...
                      </p>
                    )}
                  </>
                ) : (
                  <p className="preset-preview">{preset.prompt.substring(0, 60)}...</p>
                )}
              </div>
              <div className="preset-card-actions">
                <button
                  className="view-preset-btn"
                  onClick={() => setViewingPreset(preset)}
                >
                  {t('settings.viewPreset', 'View')}
                </button>
                {preset.id === 'translate-directly' ? (
                  <button
                    className="use-preset-btn"
                    onClick={() => handleSelectPreset(preset, targetLanguage)}
                    disabled={!targetLanguage.trim()}
                    title={!targetLanguage.trim() ? t('translation.languageRequired', 'Please enter a target language') : ''}
                  >
                    {t('settings.usePreset', 'Use')}
                  </button>
                ) : (
                  <button
                    className="use-preset-btn"
                    onClick={() => handleSelectPreset(preset)}
                  >
                    {t('settings.usePreset', 'Use')}
                  </button>
                )}
              </div>
            </div>
          ))}

          {/* User presets */}
          {userPromptPresets.map(preset => (
            <div className="prompt-preset-card user-preset" key={preset.id}>
              <div className="preset-card-content">
                <h5 className="preset-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {/* User icon for custom presets */}
                  <span className="material-symbols-rounded" style={{ fontSize: 18 }}>person</span>
                  {preset.title}
                </h5>
                <p className="preset-preview">{preset.prompt.substring(0, 60)}...</p>
              </div>
              <div className="preset-card-actions">
                <button
                  className="view-preset-btn"
                  onClick={() => setViewingPreset(preset)}
                >
                  {t('settings.viewPreset', 'View')}
                </button>
                <button
                  className="use-preset-btn"
                  onClick={() => handleSelectPreset(preset)}
                >
                  {t('settings.usePreset', 'Use')}
                </button>
                <button
                  className="delete-preset-btn"
                  onClick={() => handleDeletePreset(preset.id)}
                >
                  {t('settings.deletePreset', 'Delete')}
                </button>
              </div>
            </div>
          ))}

          {/* Add new preset card */}
          {!showAddPresetForm ? (
            <div
              className="add-preset-card"
              onClick={() => setShowAddPresetForm(true)}
            >
              <div className="add-preset-icon">+</div>
              <p>{t('settings.addPreset', 'Add New Preset')}</p>
            </div>
          ) : (
            <div className="new-preset-form">
              <input
                type="text"
                value={newPresetTitle}
                onChange={(e) => setNewPresetTitle(e.target.value)}
                placeholder={t('settings.presetTitlePlaceholder', 'Preset title')}
                className="preset-title-input"
              />
              <div className="new-preset-actions">
                <button
                  className="cancel-preset-btn"
                  onClick={() => {
                    setShowAddPresetForm(false);
                    setNewPresetTitle('');
                  }}
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  className="save-preset-btn"
                  onClick={handleAddPreset}
                  disabled={!newPresetTitle.trim()}
                >
                  {t('common.save', 'Save')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Current Prompt Editor */}
      <div className="transcription-prompt-setting">
        <h4>{t('settings.transcriptionPrompt', 'Transcription Prompt')}</h4>
        <p className="setting-description">
          {t('settings.transcriptionPromptDescription', 'Customize the prompt sent to Gemini for transcription. The {contentType} placeholder will be replaced with "video" or "audio" depending on the input type. This placeholder cannot be removed and is required for the transcription to work properly.')}
        </p>
        <div className="prompt-editor-container transcription-prompt-setting">
          <CustomScrollbarTextarea
            id="transcription-prompt"
            ref={textareaRef}
            value={transcriptionPrompt}
            onKeyDown={(e) => {
              // Prevent deletion of {contentType} with Delete or Backspace keys
              const contentTypePos = transcriptionPrompt.indexOf('{contentType}');
              if (contentTypePos !== -1) {
                const cursorPos = e.target.selectionStart;
                const selectionEnd = e.target.selectionEnd;
                const hasSelection = cursorPos !== selectionEnd;

                // Check if selection includes the placeholder
                const selectionIncludesPlaceholder =
                  hasSelection &&
                  cursorPos <= contentTypePos + '{contentType}'.length &&
                  selectionEnd >= contentTypePos;

                // Check if cursor is at the start or end of placeholder
                const cursorAtPlaceholderStart = cursorPos === contentTypePos && e.key === 'Delete';
                const cursorAtPlaceholderEnd = cursorPos === contentTypePos + '{contentType}'.length && e.key === 'Backspace';

                // Check if cursor is inside placeholder
                const cursorInsidePlaceholder =
                  cursorPos > contentTypePos &&
                  cursorPos < contentTypePos + '{contentType}'.length &&
                  (e.key === 'Delete' || e.key === 'Backspace');

                // Prevent cut/delete operations on the placeholder
                if ((selectionIncludesPlaceholder || cursorAtPlaceholderStart || cursorAtPlaceholderEnd || cursorInsidePlaceholder) &&
                    (e.key === 'Delete' || e.key === 'Backspace' || (e.key === 'x' && e.ctrlKey) || (e.key === 'X' && e.ctrlKey))) {
                  e.preventDefault();
                }
              }
            }}
            onCut={(e) => {
              // Prevent cutting the placeholder
              const contentTypePos = transcriptionPrompt.indexOf('{contentType}');
              if (contentTypePos !== -1) {
                const cursorPos = e.target.selectionStart;
                const selectionEnd = e.target.selectionEnd;

                // Check if selection includes the placeholder
                if (cursorPos <= contentTypePos + '{contentType}'.length && selectionEnd >= contentTypePos) {
                  e.preventDefault();
                }
              }
            }}
            onPaste={(e) => {
              // Handle paste to ensure placeholder is preserved
              const contentTypePos = transcriptionPrompt.indexOf('{contentType}');
              if (contentTypePos !== -1) {
                const cursorPos = e.target.selectionStart;
                const selectionEnd = e.target.selectionEnd;

                // Check if selection includes the placeholder
                if (cursorPos <= contentTypePos + '{contentType}'.length && selectionEnd >= contentTypePos) {
                  e.preventDefault();

                  // Get pasted text
                  const pastedText = e.clipboardData.getData('text');

                  // Create new text with placeholder preserved
                  const newText =
                    transcriptionPrompt.substring(0, cursorPos) +
                    pastedText +
                    transcriptionPrompt.substring(selectionEnd);

                  // If the new text doesn't include the placeholder, add it back
                  if (!newText.includes('{contentType}')) {
                    // Add placeholder at cursor position after paste
                    const updatedText =
                      transcriptionPrompt.substring(0, cursorPos) +
                      pastedText +
                      '{contentType}' +
                      transcriptionPrompt.substring(selectionEnd);

                    setTranscriptionPrompt(updatedText);

                    // Set cursor position after the pasted text
                    setTimeout(() => {
                      const newPos = cursorPos + pastedText.length + '{contentType}'.length;
                      e.target.selectionStart = newPos;
                      e.target.selectionEnd = newPos;
                    }, 0);
                  } else {
                    // Placeholder is still in the text, just update normally
                    setTranscriptionPrompt(newText);

                    // Set cursor position after the pasted text
                    setTimeout(() => {
                      const newPos = cursorPos + pastedText.length;
                      e.target.selectionStart = newPos;
                      e.target.selectionEnd = newPos;
                    }, 0);
                  }
                }
              }
            }}
            onChange={(e) => {
              // Get current and new values
              const currentValue = transcriptionPrompt;
              const newValue = e.target.value;
              const cursorPos = e.target.selectionStart;

              // Check if {contentType} was removed
              if (!newValue.includes('{contentType}')) {
                // Find where {contentType} was in the original text
                const contentTypePos = currentValue.indexOf('{contentType}');

                if (contentTypePos !== -1) {
                  // Determine if user is trying to delete the placeholder
                  const isDeleteAttempt =
                    // Check if cursor is at or near the placeholder position
                    (cursorPos >= contentTypePos && cursorPos <= contentTypePos + '{contentType}'.length) ||
                    // Or if text before and after the placeholder matches the new value
                    (currentValue.substring(0, contentTypePos) +
                     currentValue.substring(contentTypePos + '{contentType}'.length) === newValue);

                  if (isDeleteAttempt) {
                    // Prevent deletion by keeping the original value
                    e.target.value = currentValue;
                    // Restore cursor position
                    setTimeout(() => {
                      e.target.selectionStart = cursorPos;
                      e.target.selectionEnd = cursorPos;
                    }, 0);
                    return; // Exit without updating state
                  } else {
                    // If it wasn't a direct deletion attempt, add it back at cursor position
                    const restoredValue = newValue.substring(0, cursorPos) +
                                        '{contentType}' +
                                        newValue.substring(cursorPos);
                    setTranscriptionPrompt(restoredValue);
                    // Position cursor after the placeholder
                    setTimeout(() => {
                      const newPos = cursorPos + '{contentType}'.length;
                      e.target.selectionStart = newPos;
                      e.target.selectionEnd = newPos;
                    }, 0);
                    return;
                  }
                }
              }

              // If we get here, the placeholder is still in the text or was handled above
              setTranscriptionPrompt(newValue);
            }}
            // No placeholder needed since we're pre-filling with the default prompt
            rows={8}
            className="transcription-prompt-textarea"
          />
        </div>
        <div className="prompt-actions">
          <button
            className="reset-prompt-btn"
            onClick={() => setTranscriptionPrompt(DEFAULT_TRANSCRIPTION_PROMPT)}
          >
            {t('settings.resetPrompt', 'Reset to Default')}
          </button>
          {!showAddPresetForm && (
            <button
              className="save-as-preset-btn"
              onClick={() => setShowAddPresetForm(true)}
            >
              {t('settings.saveAsPreset', 'Save as Preset')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PromptsTab;
