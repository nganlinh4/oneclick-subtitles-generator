import { useTranslation } from 'react-i18next';
import DownloadOptionsModal from './DownloadOptionsModal';

// Download button + download options modal. Operation status is owned by the global toast panel.
const LyricsDownloadAndOutput = ({
  lyrics,
  translatedSubtitles,
  isModalOpen,
  onOpenModal,
  onCloseModal,
  onDownload,
  onProcess,
  namingInfo
}) => {
  const { t } = useTranslation();
  const { sourceSubtitleName = '', videoName = '', targetLanguages = [] } = namingInfo || {};

  return (
    <div className="download-buttons">
      <button
        className="btn-base btn-primary btn-large download-btn-primary"
        onClick={onOpenModal}
        disabled={!lyrics.length}
      >
        <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>download</span>
        <span>{t('download.downloadCenter', 'Download Center')}</span>
      </button>

      {/* Download Options Modal */}
      <DownloadOptionsModal
        isOpen={isModalOpen}
        onClose={onCloseModal}
        onDownload={onDownload}
        onProcess={onProcess}
        hasTranslation={translatedSubtitles && translatedSubtitles.length > 0}
        hasOriginal={lyrics && lyrics.length > 0}
        sourceSubtitleName={sourceSubtitleName}
        videoName={videoName}
        targetLanguages={targetLanguages}
      />
    </div>
  );
};

export default LyricsDownloadAndOutput;
