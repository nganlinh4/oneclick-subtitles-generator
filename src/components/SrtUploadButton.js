import React, { useRef, useState, useEffect } from 'react';
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

  // Add processing animation when file is being read
  useEffect(() => {
    if (isProcessing) {
      const timer = setTimeout(() => {
        setIsProcessing(false);
      }, 2000); // Reset after 2 seconds
      return () => clearTimeout(timer);
    }
  }, [isProcessing]);

  const handleButtonClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = (event) => {
    const file = event.target.files[0];
    const fileName = file?.name.toLowerCase();

    if (file && (fileName.endsWith('.srt') || fileName.endsWith('.json'))) {
      setIsProcessing(true); // Start processing animation
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target.result;

        // For JSON files, validate the format
        if (fileName.endsWith('.json')) {
          try {
            const jsonData = JSON.parse(content);
            if (!Array.isArray(jsonData)) {
              alert(t('errors.invalidJsonFile', 'JSON file must contain an array of subtitles'));
              setIsProcessing(false);
              return;
            }
            // Validate that it has the expected subtitle structure
            if (jsonData.length > 0) {
              const firstItem = jsonData[0];
              if (!firstItem.hasOwnProperty('start') || !firstItem.hasOwnProperty('end') || !firstItem.hasOwnProperty('text')) {
                alert(t('errors.invalidJsonStructure', 'JSON subtitles must have start, end, and text properties'));
                setIsProcessing(false);
                return;
              }
            }
          } catch (error) {
            alert(t('errors.invalidJsonFormat', 'Invalid JSON format'));
            setIsProcessing(false);
            return;
          }
        }

        onSrtUpload(content, file.name);
      };
      reader.readAsText(file);
    } else if (file) {
      alert(t('errors.invalidSubtitleFile', 'Please select a valid SRT or JSON subtitle file'));
    }

    // Reset the input so the same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleClearSrt = () => {
    if (onSrtClear) {
      onSrtClear();
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
      const fileName = file?.name.toLowerCase();

      if (file && (fileName.endsWith('.srt') || fileName.endsWith('.json'))) {
        setIsProcessing(true); // Start processing animation
        const reader = new FileReader();
        reader.onload = (e) => {
          const content = e.target.result;

          // For JSON files, validate the format
          if (fileName.endsWith('.json')) {
            try {
              const jsonData = JSON.parse(content);
              if (!Array.isArray(jsonData)) {
                alert(t('errors.invalidJsonFile', 'JSON file must contain an array of subtitles'));
                setIsProcessing(false);
                return;
              }
              // Validate that it has the expected subtitle structure
              if (jsonData.length > 0) {
                const firstItem = jsonData[0];
                if (!firstItem.hasOwnProperty('start') || !firstItem.hasOwnProperty('end') || !firstItem.hasOwnProperty('text')) {
                  alert(t('errors.invalidJsonStructure', 'JSON subtitles must have start, end, and text properties'));
                  setIsProcessing(false);
                  return;
                }
              }
            } catch (error) {
              alert(t('errors.invalidJsonFormat', 'Invalid JSON format'));
              setIsProcessing(false);
              return;
            }
          }

          onSrtUpload(content, file.name);
        };
        reader.readAsText(file);
      } else if (file) {
        alert(t('errors.invalidSubtitleFile', 'Please select a valid SRT or JSON subtitle file'));
      }
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
