/**
 * Utility functions for splitting subtitles
 * Extracted from SubtitleSplitModal for reuse in streaming processing
 */

/**
 * Smart word counting function that handles multiple languages
 * @param {string} text - Text to count words from
 * @returns {number} - Word count
 */
export const countWords = (text) => {
  if (!text || typeof text !== 'string') return 0;
  
  // Remove extra whitespace and trim
  const cleanText = text.trim().replace(/\s+/g, ' ');
  if (!cleanText) return 0;
  
  // Check if text contains CJK characters (Chinese, Japanese, Korean)
  const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
  const hasCJK = cjkPattern.test(cleanText);
  
  if (hasCJK) {
    // For CJK languages, count characters instead of words
    // Remove spaces and punctuation for character counting
    const cjkText = cleanText.replace(/[\s\p{P}]/gu, '');
    return cjkText.length;
  } else {
    // For Latin-based languages, count words by splitting on whitespace
    return cleanText.split(/\s+/).length;
  }
};

/**
 * Smart text splitting function that handles multiple languages
 * Prioritizes even or near-even distribution of content
 * @param {string} text - Text to split
 * @param {number} maxWords - Maximum words/characters per chunk
 * @returns {Array} - Array of text chunks with their word counts
 */
const smartSplitText = (text, maxWords) => {
  if (!text || maxWords <= 0) return [{ text, wordCount: countWords(text) }];

  const totalWords = countWords(text);
  if (totalWords <= maxWords) {
    return [{ text, wordCount: totalWords }];
  }

  // Calculate optimal number of chunks for even distribution
  const numChunks = Math.ceil(totalWords / maxWords);

  // Check if text contains CJK characters
  const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
  const hasCJK = cjkPattern.test(text);

  const chunks = [];

  if (hasCJK) {
    // For CJK languages, split by characters
    const cleanText = text.replace(/\s+/g, ' ').trim();
    let currentChunk = '';
    let currentCount = 0;
    let chunkIndex = 0;

    for (let i = 0; i < cleanText.length; i++) {
      const char = cleanText[i];
      const isSpace = /\s/.test(char);
      const isPunctuation = /\p{P}/u.test(char);

      // Add character to current chunk
      currentChunk += char;

      // Count non-space, non-punctuation characters
      if (!isSpace && !isPunctuation) {
        currentCount++;
      }

      // Calculate target for current chunk (distribute remaining evenly)
      const remainingChunks = numChunks - chunkIndex;
      const remainingWords = totalWords - chunks.reduce((sum, chunk) => sum + chunk.wordCount, 0);
      const currentTarget = Math.ceil(remainingWords / remainingChunks);

      // Check if we should split here
      if (currentCount >= currentTarget && chunkIndex < numChunks - 1) {
        // Try to find a good break point (space or punctuation)
        let breakPoint = currentChunk.length;
        for (let j = currentChunk.length - 1; j >= Math.max(0, currentChunk.length - 10); j--) {
          if (/[\s\p{P}]/u.test(currentChunk[j])) {
            breakPoint = j + 1;
            break;
          }
        }

        const chunkText = currentChunk.substring(0, breakPoint).trim();
        if (chunkText) {
          chunks.push({ text: chunkText, wordCount: countWords(chunkText) });
          chunkIndex++;
        }

        // Start new chunk with remaining text
        currentChunk = currentChunk.substring(breakPoint);
        currentCount = countWords(currentChunk);
      }
    }

    // Add remaining text
    if (currentChunk.trim()) {
      chunks.push({ text: currentChunk.trim(), wordCount: countWords(currentChunk.trim()) });
    }
  } else {
    // For Latin-based languages, split by words
    const words = text.trim().split(/\s+/);
    let currentChunk = [];
    let chunkIndex = 0;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      currentChunk.push(word);

      // Calculate target for current chunk (distribute remaining evenly)
      const remainingChunks = numChunks - chunkIndex;
      const remainingWords = words.length - chunks.reduce((sum, chunk) => sum + chunk.wordCount, 0) - currentChunk.length;
      const currentTarget = Math.ceil((remainingWords + currentChunk.length) / remainingChunks);

      // Check if we should split here
      if (currentChunk.length >= currentTarget && chunkIndex < numChunks - 1) {
        const chunkText = currentChunk.join(' ');
        chunks.push({ text: chunkText, wordCount: currentChunk.length });
        currentChunk = [];
        chunkIndex++;
      }
    }

    // Add remaining words
    if (currentChunk.length > 0) {
      const chunkText = currentChunk.join(' ');
      chunks.push({ text: chunkText, wordCount: currentChunk.length });
    }
  }

  return chunks.length > 0 ? chunks : [{ text, wordCount: totalWords }];
};

/**
 * Split subtitle timing proportionally based on text chunks
 * @param {number} startTime - Original start time
 * @param {number} endTime - Original end time
 * @param {Array} chunks - Array of text chunks with word counts
 * @returns {Array} - Array of timing objects
 */
const splitTiming = (startTime, endTime, chunks) => {
  if (chunks.length <= 1) {
    return [{ start: startTime, end: endTime }];
  }
  
  const totalWords = chunks.reduce((sum, chunk) => sum + chunk.wordCount, 0);
  const totalDuration = endTime - startTime;
  
  const timings = [];
  let currentTime = startTime;
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const proportion = chunk.wordCount / totalWords;
    const duration = totalDuration * proportion;
    
    const chunkStart = currentTime;
    const chunkEnd = i === chunks.length - 1 ? endTime : currentTime + duration;
    
    timings.push({
      start: chunkStart,
      end: chunkEnd
    });
    
    currentTime = chunkEnd;
  }
  
  return timings;
};

/**
 * Apply auto-split to a single subtitle
 * @param {Object} subtitle - Subtitle object with text, start, end properties
 * @param {number} maxWords - Maximum words per subtitle
 * @param {number} startingId - Starting ID for the split subtitles (optional)
 * @returns {Array} - Array of split subtitles (or single subtitle if no split needed)
 */
export const autoSplitSubtitle = (subtitle, maxWords, startingId = null) => {
  if (!subtitle || !subtitle.text) return [subtitle];
  
  const wordCount = countWords(subtitle.text);
  
  // If subtitle is already within limit, keep it as is
  if (wordCount <= maxWords) {
    return [subtitle];
  }
  
  // Split the subtitle
  const chunks = smartSplitText(subtitle.text, maxWords);
  const timings = splitTiming(
    subtitle.start || subtitle.startTime || 0,
    subtitle.end || subtitle.endTime || 0,
    chunks
  );
  
  // Create split subtitles
  return chunks.map((chunk, index) => {
    const timing = timings[index];
    // Use startingId if provided, otherwise use the original subtitle ID
    const newId = startingId !== null ? startingId + index : 
                  (subtitle.id ? parseInt(subtitle.id) + index : undefined);
    return {
      ...subtitle,
      text: chunk.text,
      start: timing.start,
      end: timing.end,
      startTime: timing.start,
      endTime: timing.end,
      id: newId,
      // Mark as split for tracking
      isSplit: true,
      originalId: subtitle.id
    };
  });
};

/**
 * Apply auto-split to an array of subtitles
 * @param {Array} subtitles - Array of subtitle objects
 * @param {number} maxWords - Maximum words per subtitle
 * @returns {Array} - Array of split subtitles with sequential IDs
 */
export const autoSplitSubtitles = (subtitles, maxWords) => {
  if (!Array.isArray(subtitles) || maxWords <= 0) return subtitles;
  
  const result = [];
  let currentId = 1; // Start with ID 1
  
  for (const subtitle of subtitles) {
    const splitSubs = autoSplitSubtitle(subtitle, maxWords, currentId);
    
    // Update each split subtitle with the correct sequential ID
    for (let i = 0; i < splitSubs.length; i++) {
      splitSubs[i].id = currentId;
      currentId++;
    }
    
    result.push(...splitSubs);
  }
  
  return result;
};
