/**
 * Audio Alignment Notification Utility
 * Shows popup notifications when aligned audio duration exceeds expected duration significantly
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { FiAlertTriangle, FiX } from 'react-icons/fi';
import i18n from '../i18n/i18n.js';
import '../styles/common/audio-alignment-notification.css';

/**
 * Show audio alignment warning notification with a simple warning style
 * @param {number} durationDifference - Difference in seconds between actual and expected duration
 * @param {Object|null} adjustmentInfo - Information about the maximum adjustment (segmentId, adjustmentAmount)
 * @param {boolean} showDurationWarning - Whether to show duration warning
 * @param {boolean} showSegmentWarning - Whether to show segment warning
 */
export const showAudioAlignmentWarning = (durationDifference, adjustmentInfo = null, showDurationWarning = false, showSegmentWarning = false) => {
  // Must have at least one warning condition
  if (!showDurationWarning && !showSegmentWarning) {
    return;
  }

  // Remove any existing notification
  const existingNotification = document.querySelector('.audio-alignment-notification-container');
  if (existingNotification) {
    existingNotification.remove();
  }

  console.log(`📦 Creating notification container...`);
  // Create container element
  const container = document.createElement('div');
  container.className = 'audio-alignment-notification-container';

  console.log(`🌐 Getting translated messages...`);

  // Determine which notification type to show
  let translationKey;
  const messageParams = {};

  if (showDurationWarning && showSegmentWarning) {
    // Both conditions met - show merged notification
    translationKey = 'narration.audioAlignmentWarningMerged';
    messageParams.duration = durationDifference.toFixed(1);
    messageParams.maxSegment = adjustmentInfo.segmentId;
    messageParams.maxAdjustment = adjustmentInfo.adjustmentAmount.toFixed(2);
  } else if (showDurationWarning) {
    // Only duration warning
    translationKey = 'narration.audioAlignmentWarning';
    messageParams.duration = durationDifference.toFixed(1);
  } else if (showSegmentWarning) {
    // Only segment warning
    translationKey = 'narration.audioAlignmentSegmentWarning';
    messageParams.maxSegment = adjustmentInfo.segmentId;
    messageParams.maxAdjustment = adjustmentInfo.adjustmentAmount.toFixed(2);
  }

  const message = i18n.t(translationKey, messageParams);
  const closeLabel = i18n.t('narration.closeNotification');
  console.log(`📝 Message: "${message}", Close label: "${closeLabel}"`);

  // Create React component for the notification using clean CSS classes
  const NotificationComponent = () => {
    const handleClose = () => {
      const notification = container.querySelector('.audio-alignment-notification');
      if (notification) {
        notification.classList.remove('visible');
        setTimeout(() => container.remove(), 300);
      } else {
        container.remove();
      }
    };

    return (
      <div className="audio-alignment-notification visible">
        <div className="notification-icon">
          <FiAlertTriangle />
        </div>
        <div className="notification-message">
          {message}
        </div>
        <button
          className="notification-close-btn"
          onClick={handleClose}
          aria-label={closeLabel}
          title={closeLabel}
        >
          <FiX />
        </button>
      </div>
    );
  };

  console.log(`🔗 Adding container to document body...`);
  // Add to document
  document.body.appendChild(container);

  console.log(`⚛️ Creating React root and rendering notification...`);
  // Render React component
  const root = ReactDOM.createRoot(container);
  root.render(<NotificationComponent />);

  console.log(`⏰ Setting up auto-remove timer (30 seconds)...`);
  // Auto-remove after 30 seconds as a fallback (in case user doesn't close it)
  setTimeout(() => {
    if (container.parentNode) {
      console.log(`🗑️ Auto-removing notification after 30 seconds`);
      container.remove();
    }
  }, 30000);

  console.log(`✅ Audio alignment warning shown: ${durationDifference.toFixed(1)}s difference`);
  console.log(`📍 Container added to DOM with class: ${container.className}`);
  console.log(`🎯 Container position: fixed, bottom: 20px, z-index: 9999`);
};

/**
 * Check response headers for duration information and show notification if needed
 * @param {Response} response - Fetch response object
 */
export const checkAudioAlignmentFromResponse = (response) => {
  try {
    console.log('🔍 Checking audio alignment from response headers...');
    console.log('📋 Available headers:', Array.from(response.headers.entries()));

    const durationDifference = parseFloat(response.headers.get('X-Duration-Difference'));
    const expectedDuration = parseFloat(response.headers.get('X-Expected-Duration'));
    const actualDuration = parseFloat(response.headers.get('X-Actual-Duration'));

    // Read adjustment statistics
    const maxAdjustmentSegment = response.headers.get('X-Max-Adjustment-Segment');
    const maxAdjustmentAmount = parseFloat(response.headers.get('X-Max-Adjustment-Amount'));
    const maxAdjustmentStrategy = response.headers.get('X-Max-Adjustment-Strategy');

    console.log(`📊 Audio alignment check: Expected ${expectedDuration}s, Actual ${actualDuration}s, Difference ${durationDifference}s`);
    console.log(`🔢 Header values - Duration Diff: "${response.headers.get('X-Duration-Difference')}", Expected: "${response.headers.get('X-Expected-Duration')}", Actual: "${response.headers.get('X-Actual-Duration')}"`);

    if (maxAdjustmentSegment && !isNaN(maxAdjustmentAmount)) {
      console.log(`📈 Max adjustment: Segment ${maxAdjustmentSegment} pushed ${maxAdjustmentAmount}s via ${maxAdjustmentStrategy}`);
    }

    // Check conditions for notifications
    const showDurationWarning = !isNaN(durationDifference) && durationDifference > 3;
    const showSegmentWarning = maxAdjustmentSegment && !isNaN(maxAdjustmentAmount) && maxAdjustmentAmount > 3;

    if (showDurationWarning || showSegmentWarning) {
      const adjustmentInfo = showSegmentWarning ? {
        segmentId: maxAdjustmentSegment,
        adjustmentAmount: maxAdjustmentAmount
      } : null;

      showAudioAlignmentWarning(durationDifference, adjustmentInfo, showDurationWarning, showSegmentWarning);
    }
  } catch (error) {
    console.error('❌ Error checking audio alignment from response:', error);
  }
};
