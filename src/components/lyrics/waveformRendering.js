// Canvas rendering for the volume visualizer. These helpers receive everything
// they need as params instead of closing over component state, so the
// component can wrap them in useCallback with the right dependency lists.

import { selectNativeWaveformLevel, setupHighDPICanvas } from './waveformLOD';

// Render the waveform onto the given canvas.
// params: { waveform, visibleTimeRange, seekableEnd, height, dbgWave }
export const renderWaveform = (canvas, containerWidth, {
    waveform,
    visibleTimeRange,
    seekableEnd,
    height,
    dbgWave,
}) => {
    if (!waveform || !visibleTimeRange) return;

    const ctx = setupHighDPICanvas(canvas, containerWidth, height);
    const { start: visibleStart, end: visibleEnd } = visibleTimeRange;

    const visibleDuration = visibleEnd - visibleStart;
    if (!(visibleDuration > 0) || !(containerWidth > 0)) return;
    const level = selectNativeWaveformLevel(waveform, visibleDuration, containerWidth);
    const lodData = level.points;
    const lodSamplesPerSecond = level.pointsPerSecond;
    const waveformEnd = Math.min(
      waveform.durationSeconds,
      typeof seekableEnd === 'number' && Number.isFinite(seekableEnd) && seekableEnd > 0
        ? seekableEnd
        : waveform.durationSeconds,
    );
    const drawStart = Math.max(0, visibleStart);
    const drawEnd = Math.min(visibleEnd, waveformEnd);

    // Calculate the samples that overlap the visible, seekable media range.
    const startSample = Math.max(0, Math.floor(drawStart * lodSamplesPerSecond));
    const endSample = Math.min(lodData.length, Math.ceil(drawEnd * lodSamplesPerSecond));
    const samplesToDraw = Math.max(0, endSample - startSample);

    dbgWave('[WAVEFORM] Rendering:', {
      duration: waveform.durationSeconds,
      totalDataLength: waveform.levels[0].points.length,
      samplesPerSecond: waveform.levels[0].pointsPerSecond,
      visibleStart: visibleStart,
      visibleEnd: visibleEnd,
      seekableEnd,
      waveformEnd,
      startSample: startSample,
      endSample: endSample,
      samplesToDraw: samplesToDraw,
      containerWidth: containerWidth
    });

    ctx.clearRect(0, 0, containerWidth, height);

    const theme = document.documentElement.getAttribute('data-theme') || 'light';
    const primaryColor = theme === 'dark' ? 'rgb(80, 200, 255)' : 'rgb(93, 95, 239)';
    const gradientColor = theme === 'dark' ? 'rgba(80, 200, 255, 0.3)' : 'rgba(93, 95, 239, 0.3)';

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, primaryColor);
    gradient.addColorStop(0.85, gradientColor);
    gradient.addColorStop(1, 'transparent');
    ctx.fillStyle = gradient;

    if (samplesToDraw <= 0 || !(drawEnd > drawStart)) return;

    const timeToCanvasX = (time) => (
      ((time - visibleStart) / visibleDuration) * containerWidth
    );
    const startX = Math.max(0, timeToCanvasX(drawStart));
    const endX = Math.min(containerWidth, timeToCanvasX(drawEnd));

    ctx.beginPath();
    ctx.moveTo(startX, height);

    for (let i = 0; i < samplesToDraw; i++) {
        const sampleIndex = startSample + i;
        if (sampleIndex >= lodData.length) break;

        // Each point summarizes a time bin. Position its centre using time,
        // never by stretching the number of remaining points to the canvas.
        const sampleTime = Math.min(
          drawEnd,
          Math.max(drawStart, (sampleIndex + 0.5) / lodSamplesPerSecond),
        );
        const x = timeToCanvasX(sampleTime);
        const rootMeanSquare = lodData[sampleIndex]?.rootMeanSquare ?? 0;
        const amplitude = waveform.peakRootMeanSquare > 0
          ? Math.max(Math.pow(rootMeanSquare / waveform.peakRootMeanSquare, 0.75), 0.01)
          : 0.01;
        const barHeight = Math.max(amplitude * height * 0.9, 0.5); // Reduced minimum height
        const y = height - barHeight;

        ctx.lineTo(x, y);
    }

    ctx.lineTo(endX, height);
    ctx.closePath();
    ctx.fill();

    dbgWave('[WAVEFORM] Rendered native level', {
      samples: samplesToDraw,
      pointsPerSecond: level.pointsPerSecond,
    });
};

// Decide whether/what to render and dispatch to renderWaveform.
// params: { canvasRef, containerRef, waveform, visibleTimeRange, height,
//           lastRenderParamsRef, renderWaveform }
export const updateVisualization = ({
    canvasRef, containerRef, waveform, visibleTimeRange, height,
    lastRenderParamsRef, renderWaveform,
}) => {
    if (!canvasRef.current || !containerRef.current || !waveform) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const containerWidth = container.clientWidth;

    const renderParams = {
      width: containerWidth,
      height: height,
      start: visibleTimeRange.start,
      end: visibleTimeRange.end,
      theme: document.documentElement.getAttribute('data-theme') || 'light',
      dataLength: waveform.levels[0].points.length
    };

    if (lastRenderParamsRef.current && JSON.stringify(lastRenderParamsRef.current) === JSON.stringify(renderParams)) {
      return;
    }

    lastRenderParamsRef.current = renderParams;

    if (containerWidth > 0) {
      renderWaveform(canvas, containerWidth);
    }
};
