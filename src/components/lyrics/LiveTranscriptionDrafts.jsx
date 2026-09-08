import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getLiveDrafts, groupLiveDraftText, subscribeLiveDrafts } from '../../platform/liveTranscriptionDrafts';

const formatWindowTime = (milliseconds) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
};

export default function LiveTranscriptionDrafts() {
  const { t } = useTranslation();
  const drafts = useSyncExternalStore(subscribeLiveDrafts, getLiveDrafts);
  return drafts.map((draft, draftIndex) => {
    const rows = groupLiveDraftText(draft.text);
    return (
      <section className="live-transcription-window" data-osg-live-window={draft.windowIndex} key={`${draft.projectId}:${draft.windowIndex}`}>
        {draft.totalWindows > 1 ? (
          <div className="live-transcription-window-label">
            <span>{draft.windowIndex + 1}/{draft.totalWindows}</span>
            <span>{formatWindowTime(draft.windowStartMs)} – {formatWindowTime(draft.windowEndMs)}</span>
          </div>
        ) : null}
        {rows.map((text, groupIndex) => (
          <div className="lyric-item" data-osg-live-draft data-osg-live-update={draft.revision} key={`${draft.projectId}:${draft.windowIndex}:${groupIndex}`} aria-live={draftIndex === drafts.length - 1 && groupIndex === rows.length - 1 ? 'polite' : undefined}>
            <div className="lyric-content">
              <span className="lyric-number">{t('processing.liveDraftTiming')}</span>
              <span className="lyric-text">{text}</span>
            </div>
          </div>
        ))}
      </section>
    );
  });
}
