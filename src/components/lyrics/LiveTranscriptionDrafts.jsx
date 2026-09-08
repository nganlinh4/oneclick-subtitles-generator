import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getLiveDrafts, subscribeLiveDrafts } from '../../platform/liveTranscriptionDrafts';
import { getActiveProjectSnapshot } from '../../platform/projectService';

export default function LiveTranscriptionDrafts() {
  const { t } = useTranslation();
  const drafts = useSyncExternalStore(subscribeLiveDrafts, getLiveDrafts);
  const projectId = getActiveProjectSnapshot()?.metadata?.id;
  return drafts.filter((draft) => draft.projectId === projectId).map((draft) => (
    <div className="lyric-item" data-osg-live-draft key={`${projectId}:${draft.windowIndex}`} aria-live="polite">
      <span className="lyric-time">{t('processing.liveDraftTiming')}</span>
      <span className="lyric-text">{draft.text}</span>
    </div>
  ));
}
