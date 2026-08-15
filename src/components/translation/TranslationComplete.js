import { useTranslation } from 'react-i18next';
import DownloadOptionsModal from '../DownloadOptionsModal';

/**
 * Translation complete component
 * @param {Object} props - Component props
 * @param {Function} props.onReset - Function to handle reset
 * @param {boolean} props.isModalOpen - Whether the download options modal is open
 * @param {Function} props.setIsModalOpen - Function to set modal open state
 * @param {Function} props.onDownload - Function to handle download
 * @param {Function} props.onProcess - Function to handle processing
 * @param {boolean} props.hasTranslation - Whether translation is available
 * @param {boolean} props.hasOriginal - Whether original subtitles are available
 * @param {string} props.sourceSubtitleName - Name of uploaded SRT file (first priority for naming)
 * @param {string} props.videoName - Name of video file (second priority for naming)
 * @param {Array} props.targetLanguages - Array of target languages for translation naming
 * @param {boolean} props.hasBulkTranslations - Whether there are bulk translation results
 * @param {Function} props.onDownloadAll - Function to download all bulk translations
 * @param {Function} props.onDownloadZip - Function to download bulk translations as ZIP
 * @param {boolean} props.isExporting - Whether a bulk export owns the save dialog
 * @param {{current: boolean}} props.exportPendingRef - Synchronous bulk export owner gate
 * @returns {JSX.Element} - Rendered component
 */
const TranslationComplete = ({
  onReset,
  isModalOpen,
  setIsModalOpen,
  onDownload,
  onProcess,
  hasTranslation = false,
  hasOriginal = true,
  sourceSubtitleName = '',
  videoName = '',
  targetLanguages = [],
  hasBulkTranslations = false,
  onDownloadAll,
  onDownloadZip,
  isExporting = false,
  exportPendingRef
}) => {
  const { t } = useTranslation();
  const exportOwnsControls = () => isExporting || exportPendingRef?.current === true;
  const exportControlsDisabled = exportOwnsControls();
  const runUnlessExporting = (operation) => {
    if (exportOwnsControls()) return { status: 'busy' };
    return operation?.();
  };

  return (
    <div className="translation-row action-row translation-complete-row">
      <div className="row-content action-content">
        {/* New Translation button */}
        <button
          className="reset-translation-button"
          onClick={() => runUnlessExporting(onReset)}
          disabled={exportControlsDisabled}
        >
          {t('translation.newTranslation', 'New Translation')}
        </button>

        {/* Bulk download buttons */}
        {hasBulkTranslations && (
          <div className="bulk-download-buttons">
            <button
              className="download-all-button"
              onClick={() => runUnlessExporting(onDownloadAll)}
              disabled={exportControlsDisabled}
              title={t('translation.bulk.downloadAll', 'Download all translated files')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>download</span>
              {t('translation.bulk.downloadAll', 'Download All')}
            </button>
            <button
              className="download-zip-button"
              onClick={() => runUnlessExporting(onDownloadZip)}
              disabled={exportControlsDisabled}
              title={t('translation.bulk.downloadZip', 'Download all as ZIP')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>sync</span>
              {t('translation.bulk.downloadZip', 'Download ZIP')}
            </button>
          </div>
        )}

        <DownloadOptionsModal
          isOpen={isModalOpen}
          onClose={() => runUnlessExporting(() => setIsModalOpen(false))}
          onDownload={(...args) => runUnlessExporting(() => onDownload?.(...args))}
          onProcess={(...args) => runUnlessExporting(() => onProcess?.(...args))}
          hasTranslation={hasTranslation}
          hasOriginal={hasOriginal}
          sourceSubtitleName={sourceSubtitleName}
          videoName={videoName}
          targetLanguages={targetLanguages}
        />
      </div>
    </div>
  );
};

export default TranslationComplete;
