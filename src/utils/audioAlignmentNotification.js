/**
 * Audio Alignment Notification Utility
 * Shows toast notifications when aligned audio duration exceeds expected duration significantly
 */

import { showWarningToast } from './toastUtils';
import i18n from '../i18n/i18n.js';

/**
 * Show audio alignment warning notification using centralized toast system
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

  // Show warning toast with 30 second duration
  showWarningToast(message, 30000);

  console.log(`✅ Audio alignment warning shown via toast: ${durationDifference.toFixed(1)}s difference`);
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
