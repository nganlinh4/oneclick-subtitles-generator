import React, { useState, useRef, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { formatTime } from '../../utils/timeFormatter';
import '../../utils/functionalScrollbar';

import CustomScrollbarTextarea from '../common/CustomScrollbarTextarea.jsx';
import Tooltip from '../common/Tooltip.jsx';

// Continuous progress indicator component
const ContinuousProgressIndicator = ({ lyric, isCurrentLyric, currentTime }) => {
  const progressRef = useRef(null);
  const animationRef = useRef(null);
  const videoRef = useRef(document.querySelector('video')); // Reference to the video element

  // Function to update the progress indicator
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const updateProgress = () => {
    if (!progressRef.current || !isCurrentLyric) return;

    // Get the current time from the video element if available, otherwise use the prop
    const video = videoRef.current;
    const time = video && !video.paused ? video.currentTime : currentTime;

    // Calculate the progress percentage
    const progress = Math.min(1, Math.max(0, (time - lyric.start) / (lyric.end - lyric.start)));

    // Update the transform
    progressRef.current.style.transform = `scaleX(${progress})`;

    // Continue the animation if this is the current lyric
    if (isCurrentLyric) {
      animationRef.current = requestAnimationFrame(updateProgress);
    }
  };

  // Set up the animation when the component mounts or when isCurrentLyric changes
  useEffect(() => {
    // If this is the current lyric, start the animation
    if (isCurrentLyric) {
      // Make sure we have the latest video reference
      videoRef.current = document.querySelector('video');

      // Start the animation
      animationRef.current = requestAnimationFrame(updateProgress);
    }

    // Clean up the animation when the component unmounts or when isCurrentLyric changes
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isCurrentLyric, lyric, updateProgress]); // Include the entire lyric object to handle any changes

  // Update when currentTime changes (for seeking)
  useEffect(() => {
    if (isCurrentLyric) {
      updateProgress();
    }
  }, [currentTime, isCurrentLyric, updateProgress]); // Include isCurrentLyric in the dependency array

  // Only render if this is the current lyric
  if (!isCurrentLyric) return null;

  return (
    <div
      ref={progressRef}
      className="progress-indicator"
      style={{
        width: '100%',
        transform: `scaleX(${Math.min(1, Math.max(0, (currentTime - lyric.start) / (lyric.end - lyric.start)))})` // Initial value
      }}
    />
  );
};

const LyricItem = ({
  lyric,
  index,
  isCurrentLyric,
  currentTime,
  allowEditing,
  isDragging,
  onLyricClick,
  onMouseDown,
  onTouchStart,
  getLastDragEnd,
  onDelete,
  onTextEdit,
  onInsert,
  onMerge,
  hasNextLyric,
  timeFormat = 'hms_ms'
}) => {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(lyric.text);
  const textInputRef = useRef(null);

  // State for showing insert arrows
  const [showInsertArrows, setShowInsertArrows] = useState(false);
  const insertTimeoutRef = useRef(null);

  // State for showing merge arrows
  const [showMergeArrows, setShowMergeArrows] = useState(false);
  const mergeTimeoutRef = useRef(null);

  // Track when user is interacting with any arrow so we can raise z-index and prevent hover steal
  const [isArrowHover, setIsArrowHover] = useState(false);


  // Handle insert container mouse enter
  const handleInsertMouseEnter = () => {
    if (insertTimeoutRef.current) {
      clearTimeout(insertTimeoutRef.current);
      insertTimeoutRef.current = null;
    }
    setShowInsertArrows(true);
    setIsArrowHover(true);
  };

  // Handle insert container mouse leave
  const handleInsertMouseLeave = () => {
    insertTimeoutRef.current = setTimeout(() => {
      // Check if the mouse is over any arrow button before hiding
      const arrowButtons = document.querySelectorAll('.insert-lyric-button-container .arrow-button');
      let isOverArrow = false;

      arrowButtons.forEach(button => {
        if (button.matches(':hover')) {
          isOverArrow = true;
        }
      });

      if (!isOverArrow) {
        setShowInsertArrows(false);
        setIsArrowHover(false);
      }
    }, 600); // reasonable delay without causing overlap issues
  };

  // Hide insert arrows shortly after leaving arrow buttons if not over container
  const handleInsertArrowMouseLeave = () => {
    insertTimeoutRef.current = setTimeout(() => {
      const anyHover = document.querySelector('.insert-lyric-button-container .arrow-button:hover');
      if (!anyHover) {
        setShowInsertArrows(false);
        setIsArrowHover(false);
      }
    }, 250);
  };

  // Handle merge container mouse enter
  const handleMergeMouseEnter = () => {
    if (mergeTimeoutRef.current) {
      clearTimeout(mergeTimeoutRef.current);
      mergeTimeoutRef.current = null;
    }
    setShowMergeArrows(true);
    setIsArrowHover(true);
  };

  // Handle merge container mouse leave
  const handleMergeMouseLeave = () => {
    mergeTimeoutRef.current = setTimeout(() => {
      // Check if the mouse is over any arrow button before hiding
      const arrowButtons = document.querySelectorAll('.merge-lyrics-button-container .arrow-button');
      let isOverArrow = false;

      arrowButtons.forEach(button => {
        if (button.matches(':hover')) {
          isOverArrow = true;
        }
      });

      if (!isOverArrow) {
        setShowMergeArrows(false);
        setIsArrowHover(false);
      }
    }, 600);
  };

  // Hide merge arrows shortly after leaving arrow buttons if not over container
  const handleMergeArrowMouseLeave = () => {
    mergeTimeoutRef.current = setTimeout(() => {
      const anyHover = document.querySelector('.merge-lyrics-button-container .arrow-button:hover');
      if (!anyHover) {
        setShowMergeArrows(false);
        setIsArrowHover(false);
      }
    }, 250);
  };

  // Clean up timeouts on unmount
  useEffect(() => {
    return () => {
      if (insertTimeoutRef.current) {
        clearTimeout(insertTimeoutRef.current);
      }
      if (mergeTimeoutRef.current) {
        clearTimeout(mergeTimeoutRef.current);
      }

    };
  }, []);

  const handleEditClick = (e) => {
    e.stopPropagation();
    // Ensure this lyric becomes the focused/current one before editing
    onLyricClick(lyric.start);
    setIsEditing(true);
    setEditText(lyric.text);
    setTimeout(() => textInputRef.current?.focus(), 0);


  };

  const handleTextSubmit = () => {
    if (editText.trim() !== lyric.text) {
      onTextEdit(index, editText.trim());
    }
    setIsEditing(false);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleTextSubmit();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
      setEditText(lyric.text);
    }
  };

  // Handle insert above
  const handleInsertAbove = (e) => {
    e.stopPropagation();
    e.preventDefault();
    // For first lyric, insert at position 0
    // For other lyrics, insert at the position before the current lyric
    onInsert(index > 0 ? index - 1 : 0);
  };

  // Handle insert below
  const handleInsertBelow = (e) => {
    e.stopPropagation();
    e.preventDefault();
    // Always insert at the current position
    // For last lyric, this will add a new lyric at the end
    onInsert(index);
  };

  // Handle merge with above
  const handleMergeAbove = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (index > 0) {
      onMerge(index - 1);
    }
  };

  // Handle merge with below
  const handleMergeBelow = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (hasNextLyric) {
      onMerge(index);
    }
  };

  return (
    <div className={`lyric-item-container ${(showInsertArrows || showMergeArrows || isArrowHover) ? 'arrow-hover' : ''}`}>
      <div
        data-lyric-index={index}
        className={`lyric-item ${isCurrentLyric ? 'current' : ''} ${(showInsertArrows || showMergeArrows || isArrowHover) ? 'arrow-hover' : ''} ${isEditing ? 'editing-active' : ''}`}
        onClick={() => {
          if (Date.now() - getLastDragEnd() < 100) {
            return;
          }
          onLyricClick(lyric.start);
        }}
      >
        <div className="lyric-content">
          {/* Lyric numbering */}
          <div className="lyric-number">
            {index + 1}
          </div>

          {/* Controls moved to the left */}
          {allowEditing && (
            <div className="lyric-controls">
              <Tooltip content={t('lyrics.editTooltip', 'Edit lyrics')}>
                <button
                  className="edit-lyric-btn"
                  onClick={handleEditClick}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>edit</span>
                </button>
              </Tooltip>
              <button
                className="delete-lyric-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(index);
                }}
                title={t('lyrics.deleteTooltip', 'Delete lyrics')}
              >
                <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>delete</span>
              </button>
              {/* Always show insert and merge buttons for all lyrics */}
              <div
                className="insert-lyric-button-container"
                onMouseEnter={handleInsertMouseEnter}
                onMouseLeave={handleInsertMouseLeave}
              >
                <div
                  className="insert-lyric-button"
                  title={t('lyrics.insertTooltip', 'Add new line')}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>add</span>
                </div>
                {showInsertArrows && (
                  <div className="arrow-buttons">
                    <button
                      className="arrow-button up"
                      onClick={handleInsertAbove}
                      title={t('lyrics.insertAbove', 'Add above')}
                      onMouseEnter={() => {
                        if (insertTimeoutRef.current) {
                          clearTimeout(insertTimeoutRef.current);
                          insertTimeoutRef.current = null;
                        }
                        setIsArrowHover(true);
                      }}
                      onMouseLeave={handleInsertArrowMouseLeave}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: '24px' }}>keyboard_arrow_up</span>
                    </button>
                    <button
                      className="arrow-button down"
                      onClick={handleInsertBelow}
                      title={t('lyrics.insertBelow', 'Add below')}
                      onMouseEnter={() => {
                        if (insertTimeoutRef.current) {
                          clearTimeout(insertTimeoutRef.current);
                          insertTimeoutRef.current = null;
                        }
                        setIsArrowHover(true);
                      }}
                      onMouseLeave={handleInsertArrowMouseLeave}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: '24px' }}>keyboard_arrow_down</span>
                    </button>
                  </div>
                )}
              </div>
              <div
                className="merge-lyrics-button-container"
                onMouseEnter={handleMergeMouseEnter}
                onMouseLeave={handleMergeMouseLeave}
              >
                <div
                  className="merge-lyrics-button"
                  title={t('lyrics.mergeTooltip', 'Merge lyrics')}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>stack_group</span>
                </div>
                {showMergeArrows && (
                  <div className="arrow-buttons">
                    <button
                      className="arrow-button up"
                      onClick={handleMergeAbove}
                      title={t('lyrics.mergeAbove', 'Merge with above')}
                      disabled={index <= 0}
                      onMouseEnter={() => {
                        if (mergeTimeoutRef.current) {
                          clearTimeout(mergeTimeoutRef.current);
                          mergeTimeoutRef.current = null;
                        }
                        setIsArrowHover(true);
                      }}
                      onMouseLeave={handleMergeArrowMouseLeave}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: '24px' }}>keyboard_arrow_up</span>
                    </button>
                    <button
                      className="arrow-button down"
                      onClick={handleMergeBelow}
                      title={t('lyrics.mergeBelow', 'Merge with below')}
                      disabled={!hasNextLyric}
                      onMouseEnter={() => {
                        if (mergeTimeoutRef.current) {
                          clearTimeout(mergeTimeoutRef.current);
                          mergeTimeoutRef.current = null;
                        }
                        setIsArrowHover(true);
                      }}
                      onMouseLeave={handleMergeArrowMouseLeave}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: '24px' }}>keyboard_arrow_down</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          <div
            className={`lyric-text ${isEditing ? 'editing' : ''}`}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (allowEditing) {
                onLyricClick(lyric.start);
                setIsEditing(true);
                setEditText(lyric.text);
                setTimeout(() => textInputRef.current?.focus(), 0);
              }
            }}
          >
            {isEditing ? (
              <CustomScrollbarTextarea
                ref={textInputRef}
                className="lyric-text-input"
                containerClassName="lyric-text-input-container compact minimal"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onBlur={handleTextSubmit}
                onKeyDown={handleKeyPress}
                rows={3}
                onClick={(e) => e.stopPropagation()}
                placeholder={t('lyrics.editPlaceholder', 'Edit lyric text')}
              />
            ) : (
              <span onClick={(e) => {
                e.stopPropagation(); // Stop propagation to prevent double click handling
                if (!isEditing) {
                  onLyricClick(lyric.start);
                }
              }}>
                {lyric.text.split('\n').map((line, lineIndex) => (
                  <React.Fragment key={lineIndex}>
                    {lineIndex > 0 && <br />}
                    {line}
                  </React.Fragment>
                ))}
              </span>
            )}
          </div>

          {/* Timing controls slightly to the left */}
          {allowEditing && (
            <div className="timing-controls">
              <span
                className={`time-control start-time ${isDragging(index, 'start') ? 'dragging' : ''}`}
                onMouseDown={(e) => onMouseDown(e, index, 'start')}
                onTouchStart={(e) => { if (typeof onTouchStart === 'function') onTouchStart(e, index, 'start'); }}
                style={{ touchAction: 'none' }}
              >
                {formatTime(lyric.start, timeFormat === 'seconds' ? 'seconds' : 'hms_ms')}
              </span>

              <span className="time-separator">-</span>

              <span
                className={`time-control end-time ${isDragging(index, 'end') ? 'dragging' : ''}`}
                onMouseDown={(e) => onMouseDown(e, index, 'end')}
                onTouchStart={(e) => { if (typeof onTouchStart === 'function') onTouchStart(e, index, 'end'); }}
                style={{ touchAction: 'none' }}
              >
                {formatTime(lyric.end, timeFormat === 'seconds' ? 'seconds' : 'hms_ms')}
              </span>
            </div>
          )}
        </div>

        <ContinuousProgressIndicator
          lyric={lyric}
          isCurrentLyric={isCurrentLyric}
          currentTime={currentTime}
        />
      </div>
    </div>
  );
};

// Use memo to prevent unnecessary re-renders
const MemoizedLyricItem = memo(LyricItem, (prevProps, nextProps) => {
  // Only re-render if these props change
  if (prevProps.isCurrentLyric !== nextProps.isCurrentLyric) return false;
  if (prevProps.isCurrentLyric && prevProps.currentTime !== nextProps.currentTime) return false;
  if (prevProps.lyric !== nextProps.lyric) return false;
  if (prevProps.isDragging !== nextProps.isDragging) return false;
  if (prevProps.isEditing !== nextProps.isEditing) return false;

  // Don't re-render for other prop changes
  return true;
});

export default MemoizedLyricItem;
