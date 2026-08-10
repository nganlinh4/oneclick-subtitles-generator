import { useEffect, useRef, useState } from 'react';

// Animated "drag to select (or Ctrl+A)" hint shown over the timeline canvas.
// Appears a couple seconds after segment selection becomes available and stays
// until the user has dragged once in the session. Owns its own animation
// state/RAF loop; the host only supplies whether selection is enabled, whether
// a drag has happened, and the translator.
const TimelineDragHint = ({ onSegmentSelect, hasDraggedInSession, t }) => {
    const [showDragHint, setShowDragHint] = useState(false);
    const dragHintAnimationRef = useRef(null);
    const [dragHintAnimationTime, setDragHintAnimationTime] = useState(0);

    // Handle drag hint animation - show when segment selection is enabled but no dragging has been done
    useEffect(() => {
        if (onSegmentSelect && !hasDraggedInSession) {
            // Start showing the hint after a short delay
            const showTimer = setTimeout(() => {
                setShowDragHint(true);

                const startTime = performance.now();
                const animate = () => {
                    const elapsed = performance.now() - startTime;
                    setDragHintAnimationTime(elapsed);
                    dragHintAnimationRef.current = requestAnimationFrame(animate);
                };

                dragHintAnimationRef.current = requestAnimationFrame(animate);
            }, 2000); // Show hint after 2 seconds

            return () => {
                clearTimeout(showTimer);
                if (dragHintAnimationRef.current) {
                    cancelAnimationFrame(dragHintAnimationRef.current);
                }
            };
        } else {
            // Hide hint and stop animation
            setShowDragHint(false);
            if (dragHintAnimationRef.current) {
                cancelAnimationFrame(dragHintAnimationRef.current);
            }
        }
    }, [onSegmentSelect, hasDraggedInSession]);

    // Clean up animation frame on unmount
    useEffect(() => {
        const dragHintAnimationRef2 = dragHintAnimationRef;
        return () => {
            const dragHintAnimation = dragHintAnimationRef2.current;
            if (dragHintAnimation) {
                cancelAnimationFrame(dragHintAnimation);
            }
        };
    }, []);

    if (!showDragHint) return null;

    return (
        <div
            style={{
                position: 'absolute',
                top: '50%',
                left: '40px',
                transform: 'translateY(-50%)',
                pointerEvents: 'none',
                zIndex: 5,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                opacity: (() => {
                    const cycleTime = 4000; // 4 seconds per cycle
                    const progress = (dragHintAnimationTime % cycleTime) / cycleTime;
                    const maxOpacity = 0.9;
                    // Smooth fade in at start and fade out at end
                    return Math.sin(progress * Math.PI) * maxOpacity;
                })()
            }}
        >
            <span
                className="material-symbols-rounded"
                style={{
                    fontSize: '48px',
                    color: 'var(--md-on-surface-variant)',
                    transform: `translateX(${(() => {
                        // Smooth continuous left-to-right only motion over full cycle
                        const cycleTime = 4000; // 4 seconds per cycle
                        const progress = (dragHintAnimationTime % cycleTime) / cycleTime;

                        // Ease in/out for the entire cycle
                        const easeInOutCubic = progress < 0.5
                            ? 4 * progress * progress * progress
                            : 1 - Math.pow(-2 * progress + 2, 3) / 2;

                        // Move a long distance for clarity
                        return easeInOutCubic * 500; // 500px horizontal movement
                    })()}px)`,

                    transition: 'none',
                    filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.2))'
                }}
            >
                touch_app
            </span>
            <span
                style={{
                    color: 'var(--md-on-surface-variant)',
                    fontSize: 14,
                    fontWeight: 600,
                    userSelect: 'none',
                    transform: `translateX(${(() => {
                        const cycleTime = 4000;
                        const progress = (dragHintAnimationTime % cycleTime) / cycleTime;
                        const easeInOutCubic = progress < 0.5
                            ? 4 * progress * progress * progress
                            : 1 - Math.pow(-2 * progress + 2, 3) / 2;
                        return easeInOutCubic * 500; // match SVG motion
                    })()}px)`,
                }}
            >
                {t('lyrics.dragHintOrShortcut', '(or Ctrl+A)')}
            </span>
        </div>
    );
};

export default TimelineDragHint;
