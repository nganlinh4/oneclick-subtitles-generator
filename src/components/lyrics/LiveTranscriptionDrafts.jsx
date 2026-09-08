import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getLiveDrafts, groupLiveDraftText, subscribeLiveDrafts } from '../../platform/liveTranscriptionDrafts';
import { getActiveProjectSnapshot } from '../../platform/projectService';

export default function LiveTranscriptionDrafts() {
  const { t } = useTranslation();
  const drafts = useSyncExternalStore(subscribeLiveDrafts, getLiveDrafts);
  const projectId = getActiveProjectSnapshot()?.metadata?.id;
  const rows = drafts.filter((draft) => draft.projectId === projectId).flatMap((draft) => (
    groupLiveDraftText(draft.text).map((text, groupIndex) => ({ ...draft, text, groupIndex }))
  ));
  return rows.map((draft, index) => (
    <div className="lyric-item" data-osg-live-draft data-osg-live-update={draft.revision} key={`${projectId}:${draft.windowIndex}:${draft.groupIndex}`} aria-live={index === rows.length - 1 ? 'polite' : undefined}>
      <div className="lyric-content">
        <span className="lyric-number">{t('processing.liveDraftTiming')}</span>
        <span className="lyric-text">{draft.text}</span>
      </div>
    </div>
  ));
}
