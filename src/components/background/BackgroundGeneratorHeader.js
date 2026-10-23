/** Title row of the background image generator: heading, prompt-editor button and collapse toggle. */
import { useTranslation } from 'react-i18next';

import BackgroundPromptEditorButton from './BackgroundPromptEditorButton';

const BackgroundGeneratorHeader = ({ isCollapsed, onToggleCollapsed }) => {
  const { t } = useTranslation();
  return (
    <div className="background-generator-header">
      <div className="header-left">
        <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span className="material-symbols-rounded" style={{ fontSize: '24px' }}>panorama</span>
          {t('backgroundGenerator.title', 'Background Image Generator')}
        </h2>
        <BackgroundPromptEditorButton />
        <span style={{
          marginLeft: '16px',
          fontSize: '12px',
          color: 'var(--md-on-surface-variant)',
          fontStyle: 'italic',
          opacity: 0.7
        }}>
          {t('backgroundGenerator.upcomingFeatures', 'Image model availability depends on your Gemini account and current quota.')}
        </span>
      </div>
      <button
        className="collapse-button"
        onClick={onToggleCollapsed}
        title={isCollapsed ? t('backgroundGenerator.expand', 'Expand') : t('backgroundGenerator.collapse', 'Collapse')}
      >
        <span className="material-symbols-rounded">{isCollapsed ? 'expand_more' : 'stat_1'}</span>
      </button>
    </div>
  );
};

export default BackgroundGeneratorHeader;
