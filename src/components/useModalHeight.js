import { useRef, useEffect, useCallback } from 'react';

/**
 * Manages the smooth height transitions for the video processing modal.
 *
 * Owns the modal/content refs and recomputes the modal height when the content
 * changes (e.g. switching between Parakeet and Gemini panels) and when the modal
 * first opens.
 *
 * @param {boolean} isOpen Whether the modal is currently open
 * @param {string} method Current processing method (drives content-change transitions)
 * @returns {{ modalRef: object, contentRef: object, updateModalHeight: Function }}
 */
const useModalHeight = (isOpen, method) => {
    const modalRef = useRef(null);
    const contentRef = useRef(null);

    // Calculate and set modal height for smooth transitions
    const updateModalHeight = useCallback(() => {
        if (modalRef.current && contentRef.current && isOpen) {
            // Get the natural height of the content
            const modalElement = modalRef.current;
            const currentHeight = modalElement.offsetHeight;

            // Temporarily set to auto to measure natural height
            modalElement.style.height = 'auto';
            const naturalHeight = modalElement.offsetHeight;

            // Set back to current height immediately (no visual change)
            modalElement.style.height = `${currentHeight}px`;

            // Force a reflow by reading offsetHeight
            void modalElement.offsetHeight;

            // Now transition to the new height
            modalElement.style.height = `${naturalHeight}px`;
        }
    }, [isOpen]);

    // Update height when content changes (method switching between Parakeet/Gemini)
    useEffect(() => {
        if (isOpen) {
            // Small delay to let DOM update
            const timer = setTimeout(() => {
                updateModalHeight();
            }, 10);
            return () => clearTimeout(timer);
        }
    }, [method, isOpen, updateModalHeight]);

    // Set initial height when modal opens
    useEffect(() => {
        if (isOpen) {
            setTimeout(() => {
                if (modalRef.current) {
                    modalRef.current.style.height = 'auto';
                    const height = modalRef.current.offsetHeight;
                    modalRef.current.style.height = `${height}px`;
                }
            }, 50);
        }
    }, [isOpen]);

    return { modalRef, contentRef, updateModalHeight };
};

export default useModalHeight;
