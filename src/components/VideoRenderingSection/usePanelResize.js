import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Resizable preview/customization split-panel logic with localStorage persistence.
 *
 * @returns {{
 *   leftPanelWidth: number,
 *   isResizing: boolean,
 *   containerRef: React.MutableRefObject<HTMLElement>,
 *   handleMouseDown: Function,
 * }}
 */
export const usePanelResize = () => {
  const [leftPanelWidth, setLeftPanelWidth] = useState(() => {
    const saved = localStorage.getItem('videoRender_leftPanelWidth');
    return saved ? parseFloat(saved) : 66.67; // Default 2fr = 66.67%
  });
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef(null);

  // Panel resizing functionality
  const handleMouseDown = (e) => {
    setIsResizing(true);
    e.preventDefault();
  };

  const handleMouseMove = useCallback((e) => {
    if (!isResizing || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const newLeftWidth = ((e.clientX - containerRect.left) / containerRect.width) * 100;

    // Calculate right panel width in pixels
    const rightWidthPx = containerRect.width * (100 - newLeftWidth) / 100;

    // Constrain right panel between 260px and 700px
    const constrainedRightWidthPx = Math.min(Math.max(rightWidthPx, 260), 700);

    // Convert back to left panel percentage
    let constrainedLeftWidth = 100 - (constrainedRightWidthPx / containerRect.width * 100);

    // Ensure left panel never goes below 300px
    const minLeftWidthPx = 300;
    const minLeftWidthPercent = (minLeftWidthPx / containerRect.width) * 100;
    constrainedLeftWidth = Math.max(constrainedLeftWidth, minLeftWidthPercent);

    setLeftPanelWidth(constrainedLeftWidth);
  }, [isResizing]);

  const handleMouseUp = () => {
    setIsResizing(false);
  };

  // Add global mouse event listeners for resizing
  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } else {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, handleMouseMove]);

  useEffect(() => {
    localStorage.setItem('videoRender_leftPanelWidth', leftPanelWidth.toString());
  }, [leftPanelWidth]);

  return {
    leftPanelWidth,
    isResizing,
    containerRef,
    handleMouseDown,
  };
};

export default usePanelResize;
