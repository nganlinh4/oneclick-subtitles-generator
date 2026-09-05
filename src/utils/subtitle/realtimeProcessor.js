/**
 * Real-time subtitle processing for streaming responses
 * Handles incremental parsing and timeline updates
 */

import { JsonArrayStream } from './jsonArrayStream';
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
    this.t = options.t || null; // Translation function for i18n
    
    // Processing state
    this.arrayStream = new JsonArrayStream();
    this.rawRows = [];
    this._settled = false;
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
    
    // Auto-split options
    this.autoSplitEnabled = options.autoSplitEnabled || false;
    this.maxWordsPerSubtitle = options.maxWordsPerSubtitle || 8;
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
      this._clearPendingUpdate();
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
    if (this._settled) return;
    if (!this.isProcessing) {
      this.isProcessing = true;
      this.onStatusUpdate({
        message: this.t ? this.t('processing.processingStreamingResponse', 'Processing streaming response...') : 'Processing streaming response...',
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
        message: this.t ? this.t('processing.processingProgress', 'Processing... ({{chunks}} chunks, {{subtitles}} subtitles found)', { chunks: this.chunkCount, subtitles: this.currentSubtitles.length }) : `Processing... (${this.chunkCount} chunks, ${this.currentSubtitles.length} subtitles found)`,
        type: 'loading'
      });
      return;
      }



      this.attemptSubtitleParsing();

      // Update status with progress
      this.onStatusUpdate({
      message: this.t ? this.t('processing.processingProgress', 'Processing... ({{chunks}} chunks, {{subtitles}} subtitles found)', { chunks: this.chunkCount, subtitles: this.currentSubtitles.length }) : `Processing... (${this.chunkCount} chunks, ${this.currentSubtitles.length} subtitles found)`,
      type: 'loading'
      });
  }

  /**
   * Attempt to parse subtitles from accumulated text
   */
  attemptSubtitleParsing() {
    try {
      const records = this.arrayStream.append(this.accumulatedText);
      if (!records.length) return;
      for (const { index, value } of records) {
        const rows = parseGeminiResponse({
          candidates: [{ content: { parts: [{ structuredJson: [value] }] } }],
        });
        for (const row of rows) {
          const stableRow = value.index === undefined ? { ...row, id: index + 1 } : row;
          const processed = this.autoSplitEnabled && this.maxWordsPerSubtitle > 0
            ? autoSplitSubtitles([stableRow], this.maxWordsPerSubtitle) : [stableRow];
          this.rawRows.push(...processed);
        }
      }
      this.currentSubtitles = this.rawRows.slice();
      this.lastValidSubtitles = this.currentSubtitles;
      this._maybeEmitUpdate({
        subtitles: this.currentSubtitles, isStreaming: true,
        chunkCount: this.chunkCount, textLength: this.accumulatedText.length,
      });
    } catch (error) {
      this.error(error);
    }
  }

  _clearPendingUpdate() {
    if (this._emitTimer) clearTimeout(this._emitTimer);
    this._emitTimer = null;
    this._pendingPayload = null;
  }

  /**
   * Handle completion of streaming
   * @param {string|Array} finalText - Final accumulated text or pre-filtered subtitles array (for early stopping)
   */
  complete(finalText) {
    if (this._settled) return;
    this._settled = true;
    this._clearPendingUpdate();
    this.isProcessing = false;
    
    // Check if we received pre-filtered subtitles (early stop scenario)
    let finalSubtitles = null;
    if (typeof finalText === 'string' && finalText.trim() === '[]') finalSubtitles = [];
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
        this.accumulatedText = 'Early stop - pre-filtered subtitles';
      } catch (e) {
        // Not JSON, treat as regular text
        this.accumulatedText = finalText;
      }
  } else if (!finalSubtitles && Array.isArray(finalText)) {
      // Direct array of subtitles
      finalSubtitles = finalText;
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
    if (Array.isArray(finalSubtitles)) {
      // Apply auto-split if enabled
      let processedSubtitles = finalSubtitles;
      if (this.autoSplitEnabled && this.maxWordsPerSubtitle > 0) {
        processedSubtitles = autoSplitSubtitles(finalSubtitles, this.maxWordsPerSubtitle);
      }
      
      this.currentSubtitles = processedSubtitles;
      this._maybeEmitUpdate({ subtitles: processedSubtitles, isStreaming: false }, true);
      this.onComplete(processedSubtitles);
      } else {
      // No valid subtitles found
      this.onError(new Error('No valid subtitles found in final response'));
    }
  }

  /**
   * Handle streaming error
   * @param {Error} error - The error that occurred
   */
  error(error) {
    if (this._settled) return;
    this._settled = true;
    this.isProcessing = false;
    this._clearPendingUpdate();
    this.onError(error);
  }

  /**
   * Reset the processor state
   */
  reset() {
    this._clearPendingUpdate();
    this.arrayStream = new JsonArrayStream();
    this.rawRows = [];
    this._settled = false;
    this.accumulatedText = '';
    this.currentSubtitles = [];
    this.lastValidSubtitles = [];
    this.chunkCount = 0;
    this.isProcessing = false;
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
