import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import LoadingIndicator from './common/LoadingIndicator';
import '../styles/SrtUploadButton.css';

/**
 * Button component for uploading SRT and JSON subtitle files
 * @param {Object} props - Component props
 * @param {Function} props.onSrtUpload - Function called when an SRT or JSON file is uploaded
 * @param {Function} props.onSrtClear - Function called when uploaded SRT is cleared
 * @param {boolean} props.disabled - Whether the button is disabled
 * @param {boolean} props.hasSrtUploaded - Whether an SRT file has been uploaded
 * @param {string} props.uploadedFileName - Name of the uploaded file
 * @returns {JSX.Element} - Rendered component
 */
const SrtUploadButton = ({
  onSrtUpload,
  onSrtClear,
  disabled = false,
  hasSrtUploaded = false,
  uploadedFileName = ''
}) => {
  const { t } = useTranslation();
  const fileInputRef = useRef(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleButtonClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const reportReadFailure = () => {
    const message = t('errors.invalidSubtitleFile', 'Please select a valid SRT or JSON subtitle file');
    if (window.addToast) window.addToast(message, 'error', 8000);
  };

  const readFile = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target.result);
    reader.onerror = () => reject(reader.error ?? new Error('subtitleFileReadFailed'));
    reader.onabort = () => reject(new Error('subtitleFileReadAborted'));
    reader.readAsText(file);
  });

  const processFile = async (file) => {
    const fileName = file?.name.toLowerCase();
    if (!file || (!fileName.endsWith('.srt') && !fileName.endsWith('.json'))) {
      if (file && window.addToast) {
        window.addToast(
          t('errors.invalidSubtitleFile', 'Please select a valid SRT or JSON subtitle file'),
          'error',
          8000
        );
      }
      return;
    }

    setIsProcessing(true);
    try {
      const content = await readFile(file);
      await onSrtUpload(content, file.name);
    } catch {
      reportReadFailure();
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFileChange = (event) => {
    const file = event.target.files[0];
    void processFile(file);

    // Reset the input so the same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleClearSrt = async () => {
    if (!onSrtClear) return;
    setIsProcessing(true);
    try {
      await onSrtClear();
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      void processFile(file);
    }
  };

  return (
    <>
      <div className="srt-upload-buttons-group">
        <div
          className={`srt-upload-button-container ${isDragOver ? 'drag-over' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <button
            className={`srt-upload-button ${hasSrtUploaded ? 'has-srt-uploaded' : ''} ${isProcessing ? 'processing' : ''}`}
            onClick={handleButtonClick}
            disabled={disabled || isProcessing}
            title={hasSrtUploaded
              ? t('srtUpload.editTooltip', 'Upload a different SRT/JSON file')
              : t('srtUpload.tooltip', 'Upload your own SRT or JSON subtitle file')}
          >
            {/* Dynamic Gemini effects container - populated by particle system */}
            <div className="gemini-icon-container"></div>

            {isProcessing ? (
              <span className="processing-text-container">
                <LoadingIndicator
                  theme="light"
                  showContainer={false}
                  size={16}
                  className="srt-processing-loading"
                  color="#FFFFFF"
                />
                <span className="processing-text">
                  {t('srtUpload.processing', 'Processing...')}
                </span>
              </span>
            ) : hasSrtUploaded ? (
              <>
                <span className="material-symbols-rounded icon">check</span>
                <span>{uploadedFileName ?
                  (uploadedFileName.length > 20 ? uploadedFileName.substring(0, 20) + '...' : uploadedFileName) :
                  t('srtUpload.srtUploaded', 'SRT uploaded')
                }</span>
              </>
            ) : (
              <>
                <span className="material-symbols-rounded">upload_file</span>
                <span>{t('srtUpload.buttonText', 'Upload SRT/JSON')}</span>
              </>
            )}
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept=".srt,.json"
            style={{ display: 'none' }}
          />
        </div>

        {/* Separate clear button */}
        {hasSrtUploaded && !isProcessing && (
          <button
            className="clear-subtitles-button"
            onClick={handleClearSrt}
            title={t('srtUpload.clearSrt', 'Clear uploaded SRT/JSON')}
            data-tooltip={t('srtUpload.clearSrt', 'Clear uploaded SRT/JSON')}
            aria-label={t('srtUpload.clearSrt', 'Clear uploaded SRT/JSON')}
            disabled={disabled}
          >
            <span className="material-symbols-rounded">close</span>
          </button>
        )}
      </div>
    </>
  );
};

export default SrtUploadButton;
