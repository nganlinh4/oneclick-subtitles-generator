import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import CustomModelDialog from '../settings/CustomModelDialog';
import StandardSlider from '../common/StandardSlider';

/**
 * Smart word counting function that handles multiple languages
 * @param {string} text - Text to count words from
 * @returns {number} - Word count
 */
const countWords = (text) => {
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

const SubtitleSplitModal = ({ isOpen, onClose, lyrics, onSplitSubtitles, selectedRange = null }) => {
  const { t } = useTranslation();
  const [maxWords, setMaxWords] = useState(8);
  
  // Format time for display
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleApply = () => {
    if (!lyrics || lyrics.length === 0) {
      onClose();
      return;
    }
    
    const newLyrics = [];
    
    lyrics.forEach((lyric) => {
      // Check if this lyric is within the selected range
      const isInRange = selectedRange && 
        lyric.start >= selectedRange.start && 
        lyric.end <= selectedRange.end;
      
      // If no range is selected or lyric is not in range, keep it as is
      if (!selectedRange || !isInRange) {
        newLyrics.push(lyric);
        return;
      }
      
      const wordCount = countWords(lyric.text);
      
      // If subtitle is already within limit, keep it as is
      if (wordCount <= maxWords) {
        newLyrics.push(lyric);
      } else {
        // Split the subtitle
        const chunks = smartSplitText(lyric.text, maxWords);
        const timings = splitTiming(lyric.startTime || lyric.start, lyric.endTime || lyric.end, chunks);
        
        chunks.forEach((chunk, index) => {
          const timing = timings[index];
          newLyrics.push({
            ...lyric,
            text: chunk.text,
            start: timing.start,
            end: timing.end,
            startTime: timing.start,
            endTime: timing.end,
            id: `${lyric.id}_${index + 1}`
          });
        });
      }
    });
    
    // Call the callback with the new lyrics
    onSplitSubtitles(newLyrics);
    onClose();
  };
  
  return (
    <CustomModelDialog
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span>{t('subtitleSplit.title', 'Chia nhỏ subtitles')}</span>
          {selectedRange && (
            <span className="segment-time">
              {formatTime(selectedRange.start)} - {formatTime(selectedRange.end)} ({Math.round(selectedRange.end - selectedRange.start)}s)
            </span>
          )}
        </div>
      }
      footer={
        <button
          className="apply-btn"
          onClick={handleApply}
          style={{
            backgroundColor: 'var(--md-primary)',
            color: 'var(--md-on-primary)',
            border: 'none',
            borderRadius: 'var(--md-shape-medium)',
            padding: '8px 16px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '500'
          }}
        >
          {t('subtitleSplit.apply', 'Áp dụng')}
        </button>
      }
    >
      <div>
        <p style={{
          marginBottom: '16px',
          color: 'var(--md-on-surface-variant)',
          fontSize: '14px',
          lineHeight: '1.4'
        }}>
          {selectedRange 
            ? t('subtitleSplit.descriptionRange', 'Chia nhỏ sub thông minh trong vùng đã chọn (các sub đã nhỏ hơn giới hạn sẽ không bị ảnh hưởng)')
            : t('subtitleSplit.description', 'Chia nhỏ sub thông minh (các sub đã nhỏ hơn giới hạn sẽ không bị ảnh hưởng)')
          }
        </p>

        <div style={{ marginBottom: '24px' }}>
          <label style={{
            display: 'block',
            marginBottom: '12px',
            fontSize: '14px',
            fontWeight: '500',
            color: 'var(--md-on-surface)'
          }}>
            {t('subtitleSplit.sliderTitle', 'Số chữ maximum của mỗi sub')}
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <StandardSlider
              value={maxWords}
              onChange={(value) => setMaxWords(parseInt(value))}
              min={1}
              max={30}
              step={1}
              orientation="Horizontal"
              size="XSmall"
              state="Enabled"
              showValueIndicator={false}
              showIcon={false}
              showStops={false}
              className="subtitle-split-slider"
              id="subtitle-split-slider"
              ariaLabel={t('subtitleSplit.sliderTitle', 'Số chữ maximum của mỗi sub')}
            />
            <span style={{
              minWidth: '100px',
              fontSize: '14px',
              fontWeight: '500',
              color: 'var(--md-primary)',
              textAlign: 'right'
            }}>
              {t('subtitleSplit.limitLabel', 'Giới hạn: {{count}} {{unit}}', {
                count: maxWords,
                unit: maxWords === 1
                  ? t('subtitleSplit.wordUnit', 'từ')
                  : t('subtitleSplit.wordsUnit', 'từ')
              })}
            </span>
          </div>
        </div>

        {/* Example section */}
        <div className="explanation-example-container" style={{
          display: 'flex',
          gap: '20px',
          marginBottom: '16px',
          alignItems: 'stretch'
        }}>
          <div className="explanation" style={{
            flex: '2',
            color: 'var(--text-color-secondary)',
            lineHeight: '1.5',
            display: 'flex',
            alignItems: 'center',
            fontSize: '14px',
            fontWeight: '500'
          }}>
            {t('subtitleSplit.exampleTitle', 'Ví dụ:')}
          </div>

          <div className="example" style={{
            flex: '8',
            backgroundColor: 'rgba(var(--md-primary-container-rgb), 0.1)',
            padding: '16px',
            borderRadius: '12px',
            borderLeft: '4px solid var(--primary-color)',
            boxShadow: 'var(--md-elevation-level1)'
          }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '16px',
              '@media (maxWidth: 768px)': {
                gridTemplateColumns: '1fr'
              }
            }}>
              <div>
                <div style={{ fontSize: '12px', marginBottom: '6px', fontWeight: '500', color: 'var(--md-on-surface)' }}>
                  {t('subtitleSplit.example1.title', '6 words, limit 5:')}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--md-on-surface-variant)', marginBottom: '3px' }}>
                  {t('subtitleSplit.example1.split', 'Split into 3-3 (not 5-1)')}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--md-primary)', fontWeight: '500' }}>
                  {t('subtitleSplit.example1.timing', 'Timings: 50%-50%')}
                </div>
              </div>

              <div>
                <div style={{ fontSize: '12px', marginBottom: '6px', fontWeight: '500', color: 'var(--md-on-surface)' }}>
                  {t('subtitleSplit.example2.title', '7 words, limit 5:')}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--md-on-surface-variant)', marginBottom: '3px' }}>
                  {t('subtitleSplit.example2.split', 'Split into 4-3 (not 5-2)')}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--md-primary)', fontWeight: '500' }}>
                  {t('subtitleSplit.example2.timing', 'Timings: 57%-43%')}
                </div>
              </div>

              <div>
                <div style={{ fontSize: '12px', marginBottom: '6px', fontWeight: '500', color: 'var(--md-on-surface)' }}>
                  {t('subtitleSplit.example3.title', '12 words, limit 5:')}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--md-on-surface-variant)', marginBottom: '3px' }}>
                  {t('subtitleSplit.example3.split', 'Split into 4-4-4 (not 5-5-2)')}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--md-primary)', fontWeight: '500' }}>
                  {t('subtitleSplit.example3.timing', 'Timings: 33%-33%-33%')}
                </div>
              </div>

              <div>
                <div style={{ fontSize: '12px', marginBottom: '6px', fontWeight: '500', color: 'var(--md-on-surface)' }}>
                  {t('subtitleSplit.example4.title', '13 words, limit 5:')}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--md-on-surface-variant)', marginBottom: '3px' }}>
                  {t('subtitleSplit.example4.split', 'Split into 5-4-4 (not 5-5-3)')}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--md-primary)', fontWeight: '500' }}>
                  {t('subtitleSplit.example4.timing', 'Timings: 38%-31%-31%')}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </CustomModelDialog>
  );
};

export default SubtitleSplitModal;
