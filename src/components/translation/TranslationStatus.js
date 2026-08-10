
/**
 * Translation status component
 * @param {Object} props - Component props
 * @param {string} props.status - Status message
 * @param {React.RefObject} props.statusRef - Reference to the status element
 * @returns {JSX.Element|null} - Rendered component or null if no status
 */
const TranslationStatus = ({ status, statusRef }) => {
  if (!status) return null;

  return (
    <div className="translation-row status-row">
      <div className="row-content">
        <div className="translation-status" ref={statusRef}>
          {status}
        </div>
      </div>
    </div>
  );
};

export default TranslationStatus;
