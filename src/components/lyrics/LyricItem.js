import React, { useState, useRef, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { formatTime } from '../../utils/timeFormatter';
import '../../utils/functionalScrollbar';

import CustomScrollbarTextarea from '../common/CustomScrollbarTextarea.jsx';

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
              <button
                className="edit-lyric-btn"
                onClick={handleEditClick}
                title={t('lyrics.editTooltip', 'Edit lyrics')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="#e3e3e3"><path d="M182 18q-44.4 0-74.7-31Q77-44 77-88.5t31-74.5q31-30 75-30h595q44.4 0 74.7 29.8Q883-133.4 883-88q0 44-31 75t-75 31H182Zm67-396h47l262-262-23-25-24-23-262 263v47Zm-105 37.2v-99.84q0-14.36 5-26.36t14-22l429-429q14-14 30.98-20.5 16.97-6.5 34.5-6.5 17.52 0 35.02 6.5Q710-932 724-918l64 62q14 14 21 31.75 7 17.74 7 35 0 18.25-7 35.75T789-723L359-292q-9 9-21 14t-26.36 5H211.8q-27.51 0-47.66-20.14Q144-313.29 144-340.8ZM707-788l-48-49 48 49ZM558-640l-23-25-24-23 47 48Z"/></svg>
              </button>
              <button
                className="delete-lyric-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(index);
                }}
                title={t('lyrics.deleteTooltip', 'Delete lyrics')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="#e3e3e3"><path d="M267-74q-57 0-96.5-39.5T131-210v-501q-28 0-47.5-19.5t-19.5-48Q64-807 83.5-827t47.5-20h205q0-27 18.8-46.5T402-913h154q28.4 0 47.88 19.36 19.47 19.36 19.47 46.64h205.61q29.04 0 48.54 20.2T897-779q0 29-19.5 48.5T829-711v501q0 57-39.5 96.5T693-74H267Zm426-637H267v501h426v-501Zm-426 0v501-501Zm213 331 63 62q16 17 39.48 16.5Q605.96-302 623-319q16-16 16-39.48 0-23.48-16-40.52l-63-61 63-62q16-17.04 16-40.52Q639-586 623-602q-17.04-17-40.52-17Q559-619 543-602l-63 62-62-62q-16-17-38.98-17-22.98 0-40.02 17-16 16-16 39.48 0 23.48 16 40.52l61 62-62 62q-16 17.04-15.5 40.02Q323-335 339-319q17.04 17 40.52 17Q403-302 419-319l61-61Z"/></svg>
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
                  <svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="#e3e3e3"><path d="M412-412H222q-29 0-48.5-20.2T154-480q0-29 19.5-48.5T222-548h190v-191q0-27.6 20.2-47.8Q452.4-807 480-807q27.6 0 47.8 20.2Q548-766.6 548-739v191h190q29 0 48.5 19.5t19.5 48q0 28.5-19.5 48.5T738-412H548v190q0 27.6-20.2 47.8Q507.6-154 480-154q-27.6 0-47.8-20.2Q412-194.4 412-222v-190Z"/></svg>
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
                      <svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="#e3e3e3"><path d="M480-74q-28 0-48-19.5T412-142v-269H142q-29 0-48.5-19.5T74-479q0-28 19.5-48t48.5-20h269v-271q0-29 19.5-48.5T479-886q28 0 48 19.5t20 48.5v270h271q29 0 48.5 20t19.5 48q0 28-19.5 48T818-412H548v270q0 29-20 48.5T480-74Z"/></svg>
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
                      <svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="#e3e3e3"><path d="M480-74q-28 0-48-19.5T412-142v-269H142q-29 0-48.5-19.5T74-479q0-28 19.5-48t48.5-20h269v-271q0-29 19.5-48.5T479-886q28 0 48 19.5t20 48.5v270h271q29 0 48.5 20t19.5 48q0 28-19.5 48T818-412H548v270q0 29-20 48.5T480-74Z"/></svg>
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
                  <svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="#e3e3e3"><path d="M454-34q-57 0-96.5-39.5T318-170v-151H171q-57 0-96.5-38.8T35-457v-334q0-57 39.5-96.5T171-927h334q57 0 96.5 39.5T641-791v151h147q57 0 96.5 39.5T924-504v334q0 57-39.5 96.5T788-34H454Zm-10-126h354v-354H651q-57 0-96.5-39.5T515-650v-151H161v354h147q57 0 96.5 39.5T444-311v151Zm36-320Z"/></svg>
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
                      <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e3e3e3"><path d="m480-244-78 78q-20 19-47.5 19T307-166q-20-20-20-48t20-47l125-125q9-9 22-14.5t26-5.5q13 0 26 5.5t22 14.5l125 125q20 19 20 47t-20 48q-20 19-47.5 19T558-166l-78-78Zm0-472 78-79q20-19 47.5-19t47.5 19q20 20 20 48t-20 47L528-575q-9 10-22 15t-26 5q-13 0-26-5t-22-15L307-700q-20-19-20-47t20-48q20-19 47.5-19t47.5 19l78 79Z"/></svg>
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
                      <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e3e3e3"><path d="m480-244-78 78q-20 19-47.5 19T307-166q-20-20-20-48t20-47l125-125q9-9 22-14.5t26-5.5q13 0 26 5.5t22 14.5l125 125q20 19 20 47t-20 48q-20 19-47.5 19T558-166l-78-78Zm0-472 78-79q20-19 47.5-19t47.5 19q20 20 20 48t-20 47L528-575q-9 10-22 15t-26 5q-13 0-26-5t-22-15L307-700q-20-19-20-47t20-48q20-19 47.5-19t47.5 19l78 79Z"/></svg>
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
