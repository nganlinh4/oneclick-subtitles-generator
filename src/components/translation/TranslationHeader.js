import { useTranslation } from 'react-i18next';

/**
 * Header component for the translation section
 * @param {Object} props - Component props
 * @param {React.ReactNode} props.promptEditorButton - Prompt editor button component
 * @returns {JSX.Element} - Rendered component
 */
const TranslationHeader = ({ promptEditorButton }) => {
  const { t } = useTranslation();

  return (
    <div className="translation-header">
      <div className="header-left">
        <h3>{t('translation.title', 'Translate Subtitles')}</h3>
        {promptEditorButton}
      </div>
      <p className="translation-description">
        {t('translation.description', 'Translate your edited subtitles to another language while preserving timing information.')}
      </p>
    </div>
  );
};

export default TranslationHeader;
