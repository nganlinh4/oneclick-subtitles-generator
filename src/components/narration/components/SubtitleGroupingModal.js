import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactDOM from 'react-dom';
import CloseButton from '../../common/CloseButton';
import '../../../styles/narration/subtitleGroupingModal.css';

/**
 * Modal component to display a comparison between source subtitles and grouped subtitles
 * @param {Object} props - Component props
 * @param {boolean} props.open - Whether the modal is open
 * @param {Function} props.onClose - Function to close the modal
 * @param {Array} props.originalSubtitles - Source subtitle objects (could be original or translated)
 * @param {Array} props.groupedSubtitles - Grouped subtitle objects
 * @param {string} props.subtitleSource - The source type ('original' or 'translated')
 * @returns {JSX.Element} - Rendered component
 */
const SubtitleGroupingModal = ({ open, onClose, originalSubtitles, groupedSubtitles, subtitleSource = 'original' }) => {
  const { t } = useTranslation();
  const [groupedSubtitleMap, setGroupedSubtitleMap] = useState({});
  const [tableData, setTableData] = useState([]);

  // Process the subtitles to create the table data
  useEffect(() => {
    if (!originalSubtitles || !groupedSubtitles) return;

    // Create a map of grouped subtitles by their original IDs
    const groupMap = {};
    groupedSubtitles.forEach(group => {
      if (group.original_ids) {
        group.original_ids.forEach(id => {
          groupMap[id] = group;
        });
      }
    });
    setGroupedSubtitleMap(groupMap);

    // Create the table data
    const data = originalSubtitles.map(subtitle => {
      const id = subtitle.subtitle_id || subtitle.id;
      return {
        original: subtitle,
        grouped: groupMap[id] || null
      };
    });
    setTableData(data);
  }, [originalSubtitles, groupedSubtitles]);

  // Function to get the row span for a grouped subtitle
  const getRowSpan = (groupedSubtitle) => {
    if (!groupedSubtitle || !groupedSubtitle.original_ids) return 1;
    return groupedSubtitle.original_ids.length;
  };

  // Function to determine if a cell should be rendered
  const shouldRenderCell = (index, groupedSubtitle) => {
    if (!groupedSubtitle || !groupedSubtitle.original_ids) return true;

    // Only render the cell for the first occurrence of this grouped subtitle
    const originalId = tableData[index].original.subtitle_id || tableData[index].original.id;
    const firstId = groupedSubtitle.original_ids[0];
    return originalId === firstId;
  };

  // Format time (seconds) to MM:SS.mmm
  const formatTime = (seconds) => {
    if (seconds === undefined || seconds === null) return '';

    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  };

  // Use useEffect to prevent body scrolling when modal is open
  React.useEffect(() => {
    if (open) {
      // Disable scrolling on body when modal is open
      document.body.style.overflow = 'hidden';
    }

    // Re-enable scrolling when modal is closed
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  if (!open) return null;

  // Create portal content
  const modalContent = (
    <div className="modal-overlay" onClick={onClose} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}>
      <div className="subtitle-grouping-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>{t('narration.subtitleGroupingTitle', 'Subtitle Grouping Comparison')}</h2>
            <CloseButton onClick={onClose} variant="modal" size="medium" />
          </div>
        <div className="modal-content">
          <p className="subtitle-grouping-explanation">
            {subtitleSource === 'translated'
              ? t('narration.subtitleGroupingExplanationTranslated', 'This table shows how the translated subtitles have been grouped into fuller sentences for better narration. Each row on the left represents a translated subtitle, while the merged cells on the right show how they have been combined.')
              : t('narration.subtitleGroupingExplanation', 'This table shows how the original subtitles have been grouped into fuller sentences for better narration. Each row on the left represents an original subtitle, while the merged cells on the right show how they have been combined.')
            }
          </p>
          <div className="table-container">
          <table className="subtitle-grouping-table">
          <thead>
          <tr>
          <th width="5%" className="id-cell">{t('narration.id', 'ID')}</th>
          <th width="10%" className="time-cell">{t('narration.time', 'Time')}</th>
          <th width="35%">
          {subtitleSource === 'translated'
          ? t('narration.translatedSubtitles', 'Translated Subtitles')
          : t('narration.originalSubtitles', 'Original Subtitles')
          }
          </th>
          <th width="5%" className="id-cell">{t('narration.groupId', 'Group')}</th>
          <th width="10%" className="time-cell">{t('narration.groupTime', 'Group Time')}</th>
          <th width="35%">{t('narration.groupedSubtitles', 'Grouped Subtitles')}</th>
          </tr>
          </thead>
          <tbody>
            {tableData.map((row, index) => (
                <tr
                  key={row.original.subtitle_id || row.original.id || index}
                className={index % 2 === 0 ? 'original-subtitle' : ''}
            >
            <td className="id-cell">{row.original.subtitle_id || row.original.id}</td>
            <td className="time-cell">{formatTime(row.original.start)}<br />{formatTime(row.original.end)}</td>
            <td>{row.original.text}</td>
          {shouldRenderCell(index, row.grouped) ? (
            <>
            <td className={`id-cell ${getRowSpan(row.grouped) > 1 ? 'grouped-subtitle' : ''}`} rowSpan={getRowSpan(row.grouped)}>
            {row.grouped ? (row.grouped.subtitle_id || row.grouped.id) : '-'}
            </td>
            <td className={`time-cell ${getRowSpan(row.grouped) > 1 ? 'grouped-subtitle' : ''}`} rowSpan={getRowSpan(row.grouped)}>
            {row.grouped ? <>{formatTime(row.grouped.start)}<br />{formatTime(row.grouped.end)}</> : '-'}
            </td>
            <td className={`${getRowSpan(row.grouped) > 1 ? 'grouped-subtitle' : ''}`} rowSpan={getRowSpan(row.grouped)}>
            {row.grouped ? row.grouped.text : '-'}
            </td>
          </>
          ) : null}
          </tr>
          ))}
          </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  );

  // Use ReactDOM.createPortal to render the modal directly to the document body
  return ReactDOM.createPortal(
    modalContent,
    document.body
  );
};

export default SubtitleGroupingModal;
