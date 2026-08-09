/**
 * Gemini API Streaming Service
 * Handles streaming responses from Gemini API with real-time subtitle processing
 */

import { getNextAvailableKey, blacklistKey } from './keyManager';
import { isRateLimitError } from './isRateLimitError';
import { autoSplitSubtitles } from '../../utils/subtitle/splitUtils';
import { createRequestController, removeRequestController } from './requestManagement';
import i18n from '../../i18n/i18n';
import {
  buildStreamingRequest,
  parseAccumulatedSubtitles,
  scanSubtitlesForHallucination
} from './streamingHelpers';
import { DEFAULT_TRANSCRIPTION_MODEL_ID, normalizeMediaModelId } from '../../config/geminiModels';

/**
 * Validate if a file URI is still accessible
 * @param {string} fileUri - The file URI to validate
 * @param {string} apiKey - The API key to use
 * @returns {Promise<boolean>} - True if valid, false if not
 */
const validateFileUri = async (fileUri, apiKey) => {
  try {
    // YouTube URIs are external and not part of Files API; treat as valid
    if (/(youtube\.com|youtu\.be)\//.test(fileUri)) {
      return true;
    }

    // Make a lightweight test request to check if the file is accessible
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/files?key=${apiKey}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        }
      }
    );

    if (response.ok) {
      const files = await response.json();
      // Check if our file URI is in the list
      return files.files?.some(f => f.uri === fileUri) || false;
    }
    return false;
  } catch (error) {
    console.warn('[StreamingService] Error validating file URI:', error);
    return false;
  }
};

/**
 * Stream content generation from Gemini API
 * @param {File} file - The media file (already uploaded to Files API)
 * @param {string} fileUri - The uploaded file URI from Files API
 * @param {Object} options - Generation options
 * @param {Function} onChunk - Callback for each streaming chunk
 * @param {Function} onComplete - Callback when streaming is complete
 * @param {Function} onError - Callback for errors
 * @param {number} retryCount - Internal retry counter
 */
export const streamGeminiContent = async (file, fileUri, options = {}, onChunk, onComplete, onError, retryCount = 0) => {
  const { modelId } = options;
  const MODEL = normalizeMediaModelId(
    modelId || localStorage.getItem('gemini_model'),
    DEFAULT_TRANSCRIPTION_MODEL_ID
  );
  
  const geminiApiKey = getNextAvailableKey();
  if (!geminiApiKey) {
    onError(new Error('No valid Gemini API key available. Please add at least one API key in Settings.'));
    return;
  }
  
  // Validate file URI before proceeding (only on first attempt)
  if (retryCount === 0 && fileUri) {
    const isValid = await validateFileUri(fileUri, geminiApiKey);
    if (!isValid) {
      console.warn('[StreamingService] File URI is no longer valid, triggering re-upload...');
      // Trigger a re-upload by calling the error handler with a specific error
      onError(new Error('FILE_URI_EXPIRED: The cached file URI is no longer valid'));
      return;
    }
  }

  // Declare requestId and signal at function scope so they're accessible in catch block
  let requestId = null;
  let signal = null;

  try {
    // Determine content type
    const isAudio = file.type.startsWith('audio/') || (file.name && file.name.includes('extracted_') && file.name.endsWith('.mp4'));

    // Build the streaming request payload (prompt, file data, schema, config)
    const { requestData, useInline } = await buildStreamingRequest(file, fileUri, options, isAudio, MODEL);

    console.log('[StreamingService] Starting streaming request with model:', MODEL);

    // Create request controller for abort support
    const controller = createRequestController();
    requestId = controller.requestId;
    signal = controller.signal;

    // Make streaming request
    // Removed verbose request logging

    // Serialize once, then drop large inline payload reference to help GC
    const bodyPayload = JSON.stringify(requestData);
    if (useInline) {
      try { requestData.contents[0].parts[0].inlineData.data = null; } catch {}
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': geminiApiKey,
          'Content-Type': 'application/json',
        },
        body: bodyPayload,
        signal: signal // Add abort signal
      }
    );

    // Only log if there's an issue
    if (!response.ok) {
      console.log('[StreamingService] Response status:', response.status);
      console.log('[StreamingService] Response headers:', [...response.headers.entries()]);
    }
    
    if (!response.ok) {
      removeRequestController(requestId);
      const errorData = await response.text();
      console.error('[StreamingService] Error response body:', errorData);
      // On a rate-limit/quota, cool this key so the NEXT request rotates to another (a half-streamed
      // response can't be transparently retried, so we don't retry in-place here).
      if (isRateLimitError(response)) {
        blacklistKey(geminiApiKey);
      }
      throw new Error(`Gemini API error: ${response.status} - ${errorData}`);
    }

    // Process streaming response with options for early termination
    await processStreamingResponse(response, onChunk, onComplete, onError, options);
    
    // Clean up request controller after successful completion
    removeRequestController(requestId);

  } catch (error) {
    // Clean up request controller if it exists
    if (requestId) {
      removeRequestController(requestId);
    }
    console.error('[StreamingService] Error:', error);
    if (error.name === 'AbortError') {
      onError(new Error(i18n.t('errors.requestAborted', 'Request was cancelled')));
    } else {
      onError(error);
    }
  }
};

/**
 * Process the streaming response from Gemini API
 * @param {Response} response - Fetch response object
 * @param {Function} onChunk - Callback for each chunk
 * @param {Function} onComplete - Callback when complete
 * @param {Function} onError - Callback for errors
 * @param {Object} options - Additional options like segment info
 */
const processStreamingResponse = async (response, onChunk, onComplete, onError, options = {}) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedText = '';
  let chunkCount = 0;
  
  // Extract auto-split options
  const { autoSplitSubtitles: autoSplitEnabled, maxWordsPerSubtitle } = options;
  
  // Extract segment end offset if provided
  // Note: The property is 'end', not 'endOffset'
  const segmentEndOffset = options?.segmentInfo?.end || options?.segmentInfo?.endOffset || null;
  let shouldTerminate = false;
  let lastValidSubtitleEndTime = 0;
  
  // Stuck chunk detection variables
  let lastSubtitleCount = 0;
  let chunksWithoutNewSubtitles = 0;
  const MAX_CHUNKS_WITHOUT_SUBTITLES = 30; // If 30 chunks pass without new subtitles, we're stuck
  let lastChunkWithSubtitles = 0;
  
  console.log(`[StreamingService] Segment processing initialized:`, {
    segmentStart: options?.segmentInfo?.start || 'not set',
    segmentEnd: segmentEndOffset || 'not set',
    duration: options?.segmentInfo?.duration || 'not set'
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Decode the chunk and add to buffer
      buffer += decoder.decode(value, { stream: true });
      
      // Split by double newlines to get individual events
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || ''; // Keep the last incomplete event in buffer

      for (const event of events) {
        if (!event.trim()) continue;

        try {
          // Parse the SSE event
          const lines = event.split(/\r?\n/);
          let eventData = null;

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataContent = line.slice(6);
              if (dataContent === '[DONE]') {
                // Stream is complete
                console.log('[StreamingService] Stream completed');
                onComplete(accumulatedText);
                return;
              }
              
              try {
                eventData = JSON.parse(dataContent);
              } catch (parseError) {
                console.warn('[StreamingService] Failed to parse JSON:', dataContent);
                continue;
              }
            }
          }

          if (eventData) {
            // console.log('[StreamingService] Event data received:', JSON.stringify(eventData).substring(0, 200));
            
            // Check for error in the event data
            if (eventData.error) {
              console.error('[StreamingService] Error in event data:', eventData.error);
              onError(new Error(`Gemini API error: ${eventData.error.message || JSON.stringify(eventData.error)}`));
              return;
            }
            
            // Check if the response has no candidates (empty response)
            if (!eventData.candidates || eventData.candidates.length === 0) {
              console.warn('[StreamingService] No candidates in response:', JSON.stringify(eventData));
            }
          }
          
          if (eventData && eventData.candidates && eventData.candidates.length > 0) {
            const candidate = eventData.candidates[0];
            
            // Check for finish reasons that might indicate why no content was generated
            if (candidate.finishReason) {
              console.log('[StreamingService] Finish reason:', candidate.finishReason);
              if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION') {
                console.warn('[StreamingService] Content blocked due to:', candidate.finishReason);
                if (candidate.safetyRatings) {
                  console.warn('[StreamingService] Safety ratings:', JSON.stringify(candidate.safetyRatings));
                }
              }
            }
            
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
              const textPart = candidate.content.parts[0];
              if (textPart.text) {
                chunkCount++;
                accumulatedText += textPart.text;
                // Cap accumulated text to last 50k chars to bound memory usage
                if (accumulatedText.length > 50000) accumulatedText = accumulatedText.slice(-50000);
                
                // console.log(`[StreamingService] Chunk ${chunkCount}:`, textPart.text.substring(0, 100) + '...');
                
                // Try to parse accumulated text as subtitles
                try {
                const parsedSubtitles = parseAccumulatedSubtitles(accumulatedText);
                
                // Stuck chunk detection - check if we're getting NEW subtitles
                // CRITICAL: We need to check if the count increased, not if it's greater than last count
                if (parsedSubtitles && parsedSubtitles.length > 0) {
                  const currentSubtitleCount = parsedSubtitles.length;
                  
                  // Check if we got new subtitles in this specific chunk
                  // The parsed subtitles are accumulated, so we check if count increased
                  if (currentSubtitleCount > lastSubtitleCount) {
                    // We got new subtitles, reset the counter
                    const newSubtitlesInChunk = currentSubtitleCount - lastSubtitleCount;
                    chunksWithoutNewSubtitles = 0;
                    lastSubtitleCount = currentSubtitleCount;
                    lastChunkWithSubtitles = chunkCount;
                    
                    // Only log significant updates to reduce noise
                    // PERFORMANCE: Increased threshold to reduce logging overhead
                    if (chunkCount % 200 === 0 || newSubtitlesInChunk > 20) {
                      console.log(`[StreamingService] Progress: Chunk ${chunkCount}, Total subtitles: ${currentSubtitleCount} (+${newSubtitlesInChunk})`);
                    }
                  } else {
                    // No new subtitles in this chunk
                    chunksWithoutNewSubtitles++;
                    
                    // Log warning every 20 chunks without subtitles
                    if (chunksWithoutNewSubtitles % 20 === 0 && chunksWithoutNewSubtitles < MAX_CHUNKS_WITHOUT_SUBTITLES) {
                      console.log(`[StreamingService] Warning: ${chunksWithoutNewSubtitles} chunks without new subtitles (chunk ${chunkCount}, stuck at ${lastSubtitleCount} subtitles)`);
                    }
                    
                    if (chunksWithoutNewSubtitles >= MAX_CHUNKS_WITHOUT_SUBTITLES) {
                      console.log(`[StreamingService] 🚨 STUCK DETECTION: No new subtitles for ${chunksWithoutNewSubtitles} chunks!`);
                      console.log(`[StreamingService] Current chunk: ${chunkCount}, Stuck at: ${lastSubtitleCount} subtitles`);
                      console.log(`[StreamingService] Last subtitle received at chunk: ${lastChunkWithSubtitles}`);
                      console.log(`[StreamingService] Terminating stream due to stuck detection`);
                      shouldTerminate = true;
                      
                      // Immediately terminate the stream
                      // Apply auto-split to existing subtitles if enabled
                      let finalSubtitles = parsedSubtitles || [];
                      if (autoSplitEnabled && maxWordsPerSubtitle > 0 && finalSubtitles.length > 0) {
                        finalSubtitles = autoSplitSubtitles(finalSubtitles, maxWordsPerSubtitle);
                        console.log(`[StreamingService] Auto-split applied before termination: ${parsedSubtitles.length} -> ${finalSubtitles.length} subtitles`);
                      }
                      
                      // Send final chunk with existing subtitles
                      if (finalSubtitles.length > 0) {
                        onChunk({
                          text: textPart.text,
                          accumulatedText,
                          subtitles: finalSubtitles,
                          chunkCount,
                          isComplete: false
                        });
                      }
                      
                      // Terminate
                      reader.cancel();
                      onComplete(accumulatedText);
                      return;
                    }
                  }
                } else if (chunkCount > 10) {
                  // If we've had 10+ chunks with no subtitles at all, something's wrong
                  chunksWithoutNewSubtitles++;
                  if (chunksWithoutNewSubtitles >= 20) {
                    console.log(`[StreamingService] 🚨 STUCK DETECTION: No subtitles at all after ${chunkCount} chunks`);
                    shouldTerminate = true;
                    
                    // Immediately terminate the stream
                    reader.cancel();
                    onComplete(accumulatedText);
                    return;
                  }
                }
                
                // Check if we should terminate based on segment end offset
                if (!shouldTerminate && segmentEndOffset !== null && parsedSubtitles && parsedSubtitles.length > 0) {
                  // Scan for hallucination patterns + segment-bound violations.
                  // lastValidSubtitleEndTime persists across chunks, so it is
                  // threaded in and the updated value is read back out.
                  const scan = scanSubtitlesForHallucination(parsedSubtitles, segmentEndOffset, lastValidSubtitleEndTime);
                  const { validSubtitles, foundExceeding, foundHallucination } = scan;
                  lastValidSubtitleEndTime = scan.lastValidSubtitleEndTime;

                  // If we found hallucination or subtitles exceeding the segment, terminate
                  if (foundHallucination || foundExceeding) {
                    shouldTerminate = true;
                    
                    // Send only valid subtitles
                    if (validSubtitles.length > 0) {
                      // Apply auto-split if enabled
                      let finalSubtitles = validSubtitles;
                      if (autoSplitEnabled && maxWordsPerSubtitle > 0) {
                        finalSubtitles = autoSplitSubtitles(validSubtitles, maxWordsPerSubtitle);
                        if (finalSubtitles.length > validSubtitles.length) {
                          console.log(`[StreamingService] Auto-split applied: ${validSubtitles.length} -> ${finalSubtitles.length} subtitles`);
                        }
                      }
                      
                      onChunk({
                        text: textPart.text,
                        accumulatedText,
                        subtitles: finalSubtitles,
                        chunkCount,
                        isComplete: false
                      });
                    }
                    
                    // Terminate the stream
                    if (foundHallucination) {
                      // Log detailed reason for hallucination termination
                      const lastSubtitle = validSubtitles[validSubtitles.length - 1] || {};
                      console.log(`[StreamingService] Terminating stream - detected hallucination patterns`);
                      console.log(`[StreamingService] Hallucination reason: Check logs above for specific pattern detected`);
                      console.log(`[StreamingService] Last valid subtitle timestamp: ${lastSubtitle.start?.toFixed(1) || 0}s - ${lastSubtitle.end?.toFixed(1) || 0}s`);
                      console.log(`[StreamingService] Total valid subtitles before termination: ${validSubtitles.length}`);
                    } else {
                      console.log(`[StreamingService] Terminating stream - reached segment end offset at ${segmentEndOffset}`);
                    }
                    reader.cancel(); // Cancel the reader to stop receiving more data
                    onComplete(accumulatedText);
                    return;
                  } else {
                    // All subtitles are valid, apply auto-split if enabled
                    let finalSubtitles = validSubtitles;
                    if (autoSplitEnabled && maxWordsPerSubtitle > 0) {
                      finalSubtitles = autoSplitSubtitles(validSubtitles, maxWordsPerSubtitle);
                      // PERFORMANCE: Reduced logging - only log significant splits
                      if (finalSubtitles.length > validSubtitles.length && (finalSubtitles.length - validSubtitles.length) > 5) {
                        console.log(`[StreamingService] Auto-split applied: ${validSubtitles.length} -> ${finalSubtitles.length} subtitles`);
                      }
                    }
                    
                    onChunk({
                      text: textPart.text,
                      accumulatedText,
                      subtitles: finalSubtitles,
                      chunkCount,
                      isComplete: false
                    });
                  }
                } else if (parsedSubtitles && parsedSubtitles.length > 0) {
                  // No segment limit, apply auto-split if enabled
                  let finalSubtitles = parsedSubtitles;
                  if (autoSplitEnabled && maxWordsPerSubtitle > 0) {
                    finalSubtitles = autoSplitSubtitles(parsedSubtitles, maxWordsPerSubtitle);
                    // PERFORMANCE: Reduced logging - only log significant splits
                    if (finalSubtitles.length > parsedSubtitles.length && (finalSubtitles.length - parsedSubtitles.length) > 5) {
                      console.log(`[StreamingService] Auto-split applied: ${parsedSubtitles.length} -> ${finalSubtitles.length} subtitles`);
                    }
                  }
                  
                  onChunk({
                    text: textPart.text,
                    accumulatedText,
                    subtitles: finalSubtitles,
                    chunkCount,
                    isComplete: false
                  });
                } else {
                  // Call with raw text if parsing fails
                  onChunk({
                    text: textPart.text,
                    accumulatedText,
                    subtitles: [],
                    chunkCount,
                    isComplete: false
                  });
                }
                } catch (parseError) {
                  // Parsing failed - expected mid-stream. Log sparsely to reduce noise
                  if (chunkCount % 50 === 0) {
                    console.warn('[StreamingService] Parse error at chunk', chunkCount, ':', parseError.message);
                  }
                  
                  // Log a sample of the accumulated text to see what format we're getting
                  // PERFORMANCE: Reduced logging frequency
                  if (chunkCount % 500 === 0) { // Every 500 chunks, log a sample
                    console.log('[StreamingService] Sample of unparseable content at chunk', chunkCount, ':');
                    console.log('- Text length:', accumulatedText.length);
                    console.log('- Last 500 chars:', accumulatedText.slice(-500));
                    console.log('- Contains JSON markers:', {
                      hasOpenBracket: accumulatedText.includes('['),
                      hasCloseBracket: accumulatedText.includes(']'),
                      hasStartTime: accumulatedText.includes('startTime'),
                      hasText: accumulatedText.includes('text')
                    });
                  }
                  
                  // Continue accumulating - we'll try parsing again
                  onChunk({
                    text: textPart.text,
                    accumulatedText,
                    subtitles: [],
                    chunkCount,
                    isComplete: false
                  });
                }
              }
            }
          }
        } catch (eventError) {
          console.warn('[StreamingService] Error processing event:', eventError);
        }
      }
    }

    // Final processing
    console.log('[StreamingService] Stream ended, final text length:', accumulatedText.length);

    // If we didn't get a [DONE] signal, still complete with accumulated text
    if (accumulatedText.length > 0) {
      onComplete(accumulatedText);
    } else {
      onError(new Error('No content received from streaming response'));
    }

  } catch (streamError) {
    console.error('[StreamingService] Stream processing error:', streamError);
    onError(streamError);
  }
};

/**
 * Check if streaming is supported for the current model
 * @param {string} modelId - The model ID to check
 * @returns {boolean} - Whether streaming is supported (defaults to true for all models)
 */
export const isStreamingSupported = (modelId) => {
  // Default to supporting streaming for all models
  // The API will reject streaming if not supported, so we don't need to maintain a hardcoded list
  // Only very rare cases would not support streaming
  console.log(`[StreamingService] Defaulting to streaming support for model: ${modelId || DEFAULT_TRANSCRIPTION_MODEL_ID}`);
  return true;
};
