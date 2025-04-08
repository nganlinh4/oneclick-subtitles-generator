import React, { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Component to visualize audio volume levels
 * @param {string} audioSource - URL of the audio/video source
 * @param {number} duration - Total duration of the audio/video
 * @param {Object} visibleTimeRange - Visible time range object
 * @param {number} height - Height of the visualizer
 * @returns {React.Component} - Volume visualizer component
 */
const VolumeVisualizer = ({ audioSource, duration, visibleTimeRange, height = 30 }) => {
  const canvasRef = useRef(null);
  const [audioData, setAudioData] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isProcessed, setIsProcessed] = useState(false);
  const audioContextRef = useRef(null);
  const bufferCanvasRef = useRef(null);
  const lastRenderRangeRef = useRef(null);
  const animationFrameRef = useRef(null);
  
  // Process audio data once when the component mounts or audioSource changes
  useEffect(() => {
    if (!audioSource || isProcessed || isProcessing) return;
    
    // Skip YouTube URLs as they can't be directly processed due to CORS
    if (audioSource.includes('youtube.com') || audioSource.includes('youtu.be')) {
      console.log('YouTube URLs cannot be directly analyzed for volume visualization');
      return;
    }
    
    const processAudio = async () => {
      try {
        setIsProcessing(true);
        
        // Create audio context
        // @ts-ignore - webkitAudioContext is available in Safari but not in TypeScript types
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContext();
        }
        
        // Fetch the audio data
        const response = await fetch(audioSource);
        const arrayBuffer = await response.arrayBuffer();
        
        // Decode the audio data
        const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
        
        // Get the audio channel data (mono - just use the first channel)
        const channelData = audioBuffer.getChannelData(0);
        
        // Calculate the number of samples to analyze
        // We'll use 1000 samples for the entire duration for performance
        const sampleSize = 1000;
        const samplesPerSegment = Math.floor(channelData.length / sampleSize);
        
        // Calculate volume levels
        const volumeData = [];
        for (let i = 0; i < sampleSize; i++) {
          const startSample = i * samplesPerSegment;
          const endSample = Math.min(startSample + samplesPerSegment, channelData.length);
          
          // Calculate RMS (root mean square) for this segment
          let sum = 0;
          for (let j = startSample; j < endSample; j++) {
            sum += channelData[j] * channelData[j];
          }
          const rms = Math.sqrt(sum / (endSample - startSample));
          
          // Store the raw volume level (not normalized yet)
          volumeData.push(rms);
        }
        
        // Find the maximum volume value
        const maxVolume = Math.max(...volumeData);
        
        // Normalize the volume data to ensure the highest point will touch the ceiling
        // Apply a minimum scaling factor to ensure even quiet audio looks good
        if (maxVolume > 0) {
          // Apply a minimum scale factor of 0.15 to ensure even quiet audio is visible
          // This means that even if the audio is very quiet, we'll still see at least some bars
          const minScaleFactor = 0.15;
          
          // Scale all values
          for (let i = 0; i < volumeData.length; i++) {
            // Normalize to 0-1 range
            volumeData[i] = volumeData[i] / maxVolume;
            
            // Apply a non-linear scaling to emphasize differences
            // This makes quiet parts more visible while preserving peaks
            volumeData[i] = Math.pow(volumeData[i], 0.7);
            
            // Ensure a minimum height for better visualization
            volumeData[i] = Math.max(volumeData[i], minScaleFactor);
          }
        }
        
        // Store the processed audio data
        setAudioData(volumeData);
        setIsProcessed(true);
      } catch (error) {
        console.error('Error processing audio for visualization:', error);
      } finally {
        setIsProcessing(false);
      }
    };
    
    processAudio();
    
    // Cleanup function
    return () => {
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
    };
  }, [audioSource, isProcessed, isProcessing]);

  // Create a pre-rendered buffer of the entire waveform
  useEffect(() => {
    if (!audioData || audioData.length === 0) return;
    
    // Create an off-screen canvas for the entire waveform
    const bufferCanvas = document.createElement('canvas');
    bufferCanvas.width = audioData.length; // One pixel per data point
    bufferCanvas.height = height;
    bufferCanvasRef.current = bufferCanvas;
    
    const ctx = bufferCanvas.getContext('2d');
    
    // Clear the canvas first
    ctx.clearRect(0, 0, bufferCanvas.width, bufferCanvas.height);
    
    const theme = document.documentElement.getAttribute('data-theme') || 'light';
    
    // Set colors based on theme
    const barColor = theme === 'dark' ? 'rgb(80, 200, 255)' : 'rgb(93, 95, 239)';
    ctx.fillStyle = barColor;
    
    // Apply simple smoothing to the data
    const smoothedData = [];
    const smoothingFactor = 2; // Lower value for better performance
    
    for (let i = 0; i < audioData.length; i++) {
      let sum = 0;
      let count = 0;
      
      // Simple moving average
      for (let j = Math.max(0, i - smoothingFactor); j <= Math.min(audioData.length - 1, i + smoothingFactor); j++) {
        sum += audioData[j];
        count++;
      }
      
      smoothedData.push(sum / count);
    }
    
    // Draw the entire waveform to the buffer
    for (let i = 0; i < smoothedData.length; i++) {
      const barHeight = smoothedData[i] * height;
      const y = height - barHeight;
      ctx.fillRect(i, y, 1, barHeight);
    }
    
  }, [audioData, height]);

  // Function to draw the visualization
  const drawVisualization = useCallback(() => {
    if (!audioData || !canvasRef.current || !bufferCanvasRef.current) return;
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const bufferCanvas = bufferCanvasRef.current;
    
    // Calculate the visible range
    const { start: visibleStart, end: visibleEnd } = visibleTimeRange;
    
    // Skip redrawing if the visible range hasn't changed
    if (lastRenderRangeRef.current && 
        lastRenderRangeRef.current.start === visibleStart && 
        lastRenderRangeRef.current.end === visibleEnd) {
      return;
    }
    
    // Update the last render range
    lastRenderRangeRef.current = { start: visibleStart, end: visibleEnd };
    
    // Clear the canvas completely
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Calculate the source and destination coordinates
    const startIndex = Math.floor((visibleStart / duration) * audioData.length);
    const endIndex = Math.ceil((visibleEnd / duration) * audioData.length);
    const sourceWidth = endIndex - startIndex;
    
    // Draw the visible portion of the buffer to the canvas
    ctx.drawImage(
      bufferCanvas,
      startIndex, 0, sourceWidth, height,
      0, 0, canvas.width, canvas.height
    );
  }, [audioData, visibleTimeRange, duration, height]);

  // Listen for theme changes to redraw with appropriate colors
  useEffect(() => {
    const handleThemeChange = () => {
      // Force buffer recreation when theme changes
      if (audioData && audioData.length > 0) {
        // Create an off-screen canvas for the entire waveform
        const bufferCanvas = document.createElement('canvas');
        bufferCanvas.width = audioData.length; // One pixel per data point
        bufferCanvas.height = height;
        bufferCanvasRef.current = bufferCanvas;
        
        const ctx = bufferCanvas.getContext('2d');
        
        // Clear the canvas first
        ctx.clearRect(0, 0, bufferCanvas.width, bufferCanvas.height);
        
        const theme = document.documentElement.getAttribute('data-theme') || 'light';
        
        // Set colors based on theme
        const barColor = theme === 'dark' ? 'rgb(80, 200, 255)' : 'rgb(93, 95, 239)';
        ctx.fillStyle = barColor;
        
        // Draw the entire waveform to the buffer
        for (let i = 0; i < audioData.length; i++) {
          const barHeight = audioData[i] * height;
          const y = height - barHeight;
          ctx.fillRect(i, y, 1, barHeight);
        }
        
        // Reset last render range to force redraw
        lastRenderRangeRef.current = null;
        
        // Redraw the visualization
        drawVisualization();
      }
    };

    // Listen for storage events (theme changes)
    window.addEventListener('storage', handleThemeChange);
    
    return () => {
      window.removeEventListener('storage', handleThemeChange);
    };
  }, [audioData, height, drawVisualization]);

  // Draw the volume visualization when audioData or visibleTimeRange changes
  useEffect(() => {
    if (!canvasRef.current) return;
    
    // Use requestAnimationFrame for smoother rendering
    const updateVisualization = () => {
      drawVisualization();
      
      // Only schedule another frame if the component is still mounted
      if (canvasRef.current) {
        animationFrameRef.current = requestAnimationFrame(updateVisualization);
      }
    };
    
    // Start the animation loop
    animationFrameRef.current = requestAnimationFrame(updateVisualization);
    
    // Set up resize observer to handle canvas resizing
    const resizeObserver = new ResizeObserver(() => {
      // Reset last render range to force redraw
      lastRenderRangeRef.current = null;
    });
    
    resizeObserver.observe(canvasRef.current);
    
    return () => {
      // Cancel any pending animation frame
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      
      // Clean up resize observer
      if (canvasRef.current) {
        resizeObserver.unobserve(canvasRef.current);
      }
      resizeObserver.disconnect();
    };
  }, [audioData, visibleTimeRange, duration, height, drawVisualization]);

  // Set up canvas with appropriate attributes for better performance
  const canvasSetup = useCallback(node => {
    if (node !== null) {
      canvasRef.current = node;
      
      // Set width and height directly on the canvas element (not just style)
      // This ensures the canvas has the correct resolution
      node.width = node.clientWidth;
      node.height = height;
    }
  }, [height]);

  return (
    <div className="volume-visualizer" style={{ height: `${height}px` }}>
      <canvas 
        ref={canvasSetup}
        style={{ width: '100%', height: '100%' }}
      />
      {isProcessing && (
        <div className="volume-visualizer-loading">
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none" style={{ marginRight: '6px' }}>
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83">
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 12 12"
                to="360 12 12"
                dur="1s"
                repeatCount="indefinite"
              />
            </path>
          </svg>
          Processing audio waveform...
        </div>
      )}
    </div>
  );
};

export default VolumeVisualizer;
