/**
 * Real-time subtitle processing for streaming responses
 * Handles incremental parsing and timeline updates
 */

import { parseGeminiResponse } from './index';
import { autoSplitSubtitles } from './splitUtils';

/**
 * Real-time subtitle processor class
 * Manages streaming subtitle updates and timeline visualization
 */
export class RealtimeSubtitleProcessor {
  constructor(options = {}) {
    this.onSubtitleUpdate = options.onSubtitleUpdate || (() => {});
    this.onStatusUpdate = options.onStatusUpdate || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    
    // Processing state
    this.accumulatedText = '';
    this.currentSubtitles = [];
    this.lastValidSubtitles = [];
    this.chunkCount = 0;
  this.isProcessing = false;
  // Throttling to reduce UI churn
  this.throttleMs = typeof options.throttleMs === 'number' ? options.throttleMs : 120;
  this._lastEmitTs = 0;
  this._emitTimer = null;
  this._pendingPayload = null;
    
    // Parsing options
    this.parseAttemptInterval = 3; // Try to parse every 3 chunks
    this.minTextLength = 100; // Minimum text length before attempting parse
    
    // Auto-split options
    this.autoSplitEnabled = options.autoSplitEnabled || false;
    this.maxWordsPerSubtitle = options.maxWordsPerSubtitle || 8;
    
  console.log('[RealtimeProcessor] Initialized (auto-split:', this.autoSplitEnabled, 'max words:', this.maxWordsPerSubtitle, 'throttle:', this.throttleMs, 'ms)');
  }

  /**
   * Throttled emit to UI to cut down re-renders under heavy streaming
   */
  _maybeEmitUpdate(payload, force = false) {
    if (force) {
      if (this._emitTimer) {
        clearTimeout(this._emitTimer);
        this._emitTimer = null;
      }
      this._lastEmitTs = Date.now();
      this.onSubtitleUpdate(payload);
      return;
    }

    const now = Date.now();
    const since = now - this._lastEmitTs;
    if (since >= this.throttleMs) {
      this._lastEmitTs = now;
      this.onSubtitleUpdate(payload);
    } else {
      this._pendingPayload = payload;
      if (!this._emitTimer) {
        this._emitTimer = setTimeout(() => {
          this._emitTimer = null;
          this._lastEmitTs = Date.now();
          const toSend = this._pendingPayload;
          this._pendingPayload = null;
          this.onSubtitleUpdate(toSend);
        }, this.throttleMs - since);
      }
    }
  }

  /**
   * Process a streaming chunk
   * @param {Object} chunk - Chunk data from streaming service
   */
  processChunk(chunk) {
    if (!this.isProcessing) {
      this.isProcessing = true;
      this.onStatusUpdate({
        message: 'Processing streaming response...',
        type: 'loading'
      });
    }

    this.chunkCount++;
    this.accumulatedText = chunk.accumulatedText || '';
    
    // If upstream provided parsed subtitles (e.g., from parallel aggregator), use them directly
    if (Array.isArray(chunk.subtitles) && chunk.subtitles.length > 0) {
      let processedSubtitles = chunk.subtitles;
      
      // Apply auto-split if enabled
      if (this.autoSplitEnabled && this.maxWordsPerSubtitle > 0) {
        processedSubtitles = autoSplitSubtitles(processedSubtitles, this.maxWordsPerSubtitle);
        console.log(`[RealtimeProcessor] Auto-split: ${chunk.subtitles.length} -> ${processedSubtitles.length} subtitles`);
      }
      
      this.currentSubtitles = processedSubtitles;
      this.lastValidSubtitles = [...processedSubtitles];

      // Notify UI (throttled) with provided subtitles (avoids reparsing joined text)
      this._maybeEmitUpdate({
        subtitles: processedSubtitles,
        isStreaming: true,
        chunkCount: this.chunkCount,
        textLength: this.accumulatedText.length
      });

      // Update status with progress
      this.onStatusUpdate({
        message: `Processing... (${this.chunkCount} chunks, ${this.currentSubtitles.length} subtitles found)`,
        type: 'loading'
      });
      return;
    }

    if (this.chunkCount % 50 === 0) {
      console.log(`[RealtimeProcessor] Processing chunk ${this.chunkCount}, text length: ${this.accumulatedText.length}`);
    }

    // Try to parse subtitles periodically or if we have enough text
    const shouldAttemptParse = 
      this.chunkCount % this.parseAttemptInterval === 0 || 
      this.accumulatedText.length >= this.minTextLength;

    if (shouldAttemptParse) {
      this.attemptSubtitleParsing();
    }

    // Update status with progress
    this.onStatusUpdate({
      message: `Processing... (${this.chunkCount} chunks, ${this.currentSubtitles.length} subtitles found)`,
      type: 'loading'
    });
  }

  /**
   * Attempt to parse subtitles from accumulated text
   */
  attemptSubtitleParsing() {
    try {
      if (this.chunkCount % (this.parseAttemptInterval * 10) === 0) {
        console.log('[RealtimeProcessor] Attempting to parse subtitles...');
      }

      // Create a mock response object for the parser
      const mockResponse = {
        candidates: [{
          content: {
            parts: [{
              text: this.accumulatedText
            }]
          }
        }]
      };

      // Try to parse the accumulated text
      const parsedSubtitles = parseGeminiResponse(mockResponse);

      if (parsedSubtitles && parsedSubtitles.length > 0) {
      // Check if we have new subtitles
      if (parsedSubtitles.length > 0) {
        console.log(`[RealtimeProcessor] Found ${parsedSubtitles.length} subtitles (was ${this.currentSubtitles.length})`);

        // Apply auto-split if enabled
        let processedSubtitles = parsedSubtitles;
        if (this.autoSplitEnabled && this.maxWordsPerSubtitle > 0) {
          processedSubtitles = autoSplitSubtitles(parsedSubtitles, this.maxWordsPerSubtitle);
          // PERFORMANCE: Only log significant auto-splits
          if (processedSubtitles.length - parsedSubtitles.length > 5) {
            console.log(`[RealtimeProcessor] Auto-split: ${parsedSubtitles.length} -> ${processedSubtitles.length} subtitles`);
          }
        }

        this.currentSubtitles = processedSubtitles;
        this.lastValidSubtitles = [...processedSubtitles]; // Keep a backup

        // Notify about subtitle updates (throttled)
        this._maybeEmitUpdate({
          subtitles: processedSubtitles,
          isStreaming: true,
          chunkCount: this.chunkCount,
          textLength: this.accumulatedText.length
        });
      }
      } else {
        console.log('[RealtimeProcessor] No valid subtitles parsed yet');
      }
    } catch (error) {
      // console.debug('[RealtimeProcessor] Parsing attempt failed:', error.message);
      // Don't throw - parsing failures are expected during streaming
    }
  }

  /**
   * Handle completion of streaming
   * @param {string|Array} finalText - Final accumulated text or pre-filtered subtitles array (for early stopping)
   */
  complete(finalText) {
    console.log('[RealtimeProcessor] Stream completed, final processing...');
    
    this.isProcessing = false;
    
    // Check if we received pre-filtered subtitles (early stop scenario)
    let finalSubtitles = null;
    // Handle structured segment result object from parallel coordinator
    if (finalText && typeof finalText === 'object' && !Array.isArray(finalText)) {
      // Shape: { subtitles: Array, isSegmentResult: true, segment: {...}, text?: string }
      if (Array.isArray(finalText.subtitles)) {
        finalSubtitles = finalText.subtitles;
        this.accumulatedText = typeof finalText.text === 'string' ? finalText.text : '';
      } else if (typeof finalText.text === 'string') {
        // If only text is provided, use it as accumulated text for parsing
        this.accumulatedText = finalText.text;
      } else {
        // Fallback: stringify for diagnostics but avoid passing object directly to parser
        try {
          this.accumulatedText = JSON.stringify(finalText);
        } catch {
          this.accumulatedText = '';
        }
      }
    }
    
  if (!finalSubtitles && typeof finalText === 'string' && finalText.startsWith('[') && finalText.includes('"start"')) {
      // This looks like a JSON array of subtitles (early stop scenario)
      try {
        finalSubtitles = JSON.parse(finalText);
        console.log('[RealtimeProcessor] Using pre-filtered subtitles from early stop:', finalSubtitles.length, 'subtitles');
        this.accumulatedText = 'Early stop - pre-filtered subtitles';
      } catch (e) {
        // Not JSON, treat as regular text
        this.accumulatedText = finalText;
      }
  } else if (!finalSubtitles && Array.isArray(finalText)) {
      // Direct array of subtitles
      finalSubtitles = finalText;
      console.log('[RealtimeProcessor] Using direct subtitle array:', finalSubtitles.length, 'subtitles');
      this.accumulatedText = 'Early stop - pre-filtered subtitles';
    } else if (!finalSubtitles && typeof finalText === 'string') {
      // Regular text, need to parse
      this.accumulatedText = finalText;
    }

    // Final parsing attempt if we don't have subtitles yet
    if (!finalSubtitles) {
      try {
        // Create a mock response object for the parser
        const mockResponse = {
          candidates: [{
            content: {
              parts: [{
                text: this.accumulatedText
              }]
            }
          }]
        };

        finalSubtitles = parseGeminiResponse(mockResponse);
      } catch (error) {
        console.error('[RealtimeProcessor] Final parsing failed:', error);
        // Will handle fallback below
      }
    }

    // Process the final subtitles (either from early stop or parsed)
    if (finalSubtitles && finalSubtitles.length > 0) {
      // Apply auto-split if enabled
      let processedSubtitles = finalSubtitles;
      if (this.autoSplitEnabled && this.maxWordsPerSubtitle > 0) {
        processedSubtitles = autoSplitSubtitles(finalSubtitles, this.maxWordsPerSubtitle);
        // Always log final auto-split since it only happens once
        console.log(`[RealtimeProcessor] Final auto-split: ${finalSubtitles.length} -> ${processedSubtitles.length} subtitles`);
      }
      
      this.currentSubtitles = processedSubtitles;

      console.log(`[RealtimeProcessor] Final result: ${processedSubtitles.length} subtitles`);

      this._maybeEmitUpdate({
        subtitles: processedSubtitles,
        isStreaming: false,
        isComplete: true,
        chunkCount: this.chunkCount,
        textLength: typeof finalText === 'string' ? finalText.length : 0
      }, true);

      this.onStatusUpdate({
        message: `Processing complete! Generated ${processedSubtitles.length} subtitles.`,
        type: 'success'
      });

      this.onComplete(processedSubtitles);
    } else {
      // No valid subtitles found
      console.error('[RealtimeProcessor] No valid subtitles found in final response');

      // Fall back to last valid subtitles if available
      if (this.lastValidSubtitles.length > 0) {
        console.log('[RealtimeProcessor] Using last valid subtitles as fallback');
        this.onComplete(this.lastValidSubtitles);
        this.onStatusUpdate({
          message: `Processing complete! Generated ${this.lastValidSubtitles.length} subtitles.`,
          type: 'success'
        });
      } else {
        this.onError(new Error('No valid subtitles found in final response'));
      }
    }
  }

  /**
   * Handle streaming error
   * @param {Error} error - The error that occurred
   */
  error(error) {
    console.error('[RealtimeProcessor] Stream error:', error);
    this.isProcessing = false;
    
    // Try to salvage any subtitles we've parsed so far
    if (this.lastValidSubtitles.length > 0) {
      console.log('[RealtimeProcessor] Attempting to salvage partial results...');
      this.onStatusUpdate({
        message: `Processing interrupted. Saved ${this.lastValidSubtitles.length} subtitles.`,
        type: 'warning'
      });
      this.onComplete(this.lastValidSubtitles);
    } else {
      this.onError(error);
    }
  }

  /**
   * Reset the processor state
   */
  reset() {
    this.accumulatedText = '';
    this.currentSubtitles = [];
    this.lastValidSubtitles = [];
    this.chunkCount = 0;
    this.isProcessing = false;
    console.log('[RealtimeProcessor] Reset');
  }

  /**
   * Get current processing statistics
   * @returns {Object} - Processing stats
   */
  getStats() {
    return {
      chunkCount: this.chunkCount,
      textLength: this.accumulatedText.length,
      subtitleCount: this.currentSubtitles.length,
      isProcessing: this.isProcessing
    };
  }
}

/**
 * Create a new realtime subtitle processor
 * @param {Object} options - Processor options
 * @returns {RealtimeSubtitleProcessor} - New processor instance
 */
export const createRealtimeProcessor = (options) => {
  return new RealtimeSubtitleProcessor(options);
};
