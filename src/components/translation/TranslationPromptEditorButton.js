import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import PromptEditor from '../PromptEditor';

/**
 * Simplified prompt editor button component for the translation header
 * @param {Object} props - Component props
 * @param {string} props.customPrompt - Current custom prompt
 * @param {Function} props.onSavePrompt - Function to handle prompt save
 * @returns {JSX.Element} - Rendered component
 */
const TranslationPromptEditorButton = ({ customPrompt, onSavePrompt }) => {
  const { t } = useTranslation();
  const [isPromptEditorOpen, setIsPromptEditorOpen] = useState(false);

  return (
    <>
      <button
        className="edit-prompt-button-with-text"
        onClick={() => setIsPromptEditorOpen(true)}
        title={t('promptEditor.editPromptTooltip', 'Edit Gemini prompt')}
      >
        <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>edit</span>
        <span>{t('promptEditor.editPrompt', 'Edit Prompt')}</span>
      </button>

      <PromptEditor
        isOpen={isPromptEditorOpen}
        onClose={() => setIsPromptEditorOpen(false)}
        initialPrompt={customPrompt || `Translate the following subtitles to {targetLanguage}.

{subtitlesText}`}
        onSave={onSavePrompt}
        title={t('promptEditor.editTranslationPrompt', 'Edit Translation Prompt')}
        promptType="translation" // Explicitly set the prompt type
        description={t('promptEditor.customizeTranslationDesc', 'Add custom instructions for translation. The system will automatically handle formatting.')}
      />
    </>
  );
};

export default TranslationPromptEditorButton;
