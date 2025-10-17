import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import BackgroundPromptEditor from './BackgroundPromptEditor';

/**
 * Button component to open the background prompt editor
 * @returns {JSX.Element} - Rendered component
 */
const BackgroundPromptEditorButton = () => {
  const { t } = useTranslation();
  const [isPromptEditorOpen, setIsPromptEditorOpen] = useState(false);

  return (
    <>
      <button
        className="edit-prompt-button-with-text"
        onClick={() => setIsPromptEditorOpen(true)}
        title={t('promptEditor.editPromptAndModelTooltip', 'Edit prompt and model')}
      >
        <span className="material-symbols-rounded" style={{ fontSize: '16px', color: 'currentColor' }}>edit</span>
        <span>{t('promptEditor.editPromptAndModel', 'Edit Prompt & Model')}</span>
      </button>

      <BackgroundPromptEditor
        isOpen={isPromptEditorOpen}
        onClose={() => setIsPromptEditorOpen(false)}
      />
    </>
  );
};

export default BackgroundPromptEditorButton;
