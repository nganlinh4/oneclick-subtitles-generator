// Pure canvas painter for the wavy progress indicator: track, wavy progress stroke and stop dot.
// The caller owns animation state and passes the resolved frame values in.

const clearShadow = (ctx) => {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
};

const applyShadow = (ctx, shadow) => {
    if (!shadow.enabled) {
        clearShadow(ctx);
        return;
    }
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = shadow.blur;
    ctx.shadowOffsetX = shadow.offsetX;
    ctx.shadowOffsetY = shadow.offsetY;
};

const strokeTrack = (ctx, { width, progress, progressFrontX, strokeCapWidth, gapSize }) => {
    const trackStart = progress > 0
        ? Math.min(progressFrontX + gapSize + strokeCapWidth, width - strokeCapWidth)
        : strokeCapWidth;
    const trackEnd = width - strokeCapWidth;
    if (progress > 0 && trackStart >= trackEnd) return;
    ctx.beginPath();
    ctx.moveTo(trackStart, 0);
    ctx.lineTo(trackEnd, 0);
    ctx.stroke();
};

const traceProgress = (ctx, { progressWidth, strokeCapWidth, amplitude, waveHeight, waveOffset, wavelength }) => {
    ctx.beginPath();
    if (amplitude === 0) {
        ctx.moveTo(strokeCapWidth, 0);
        ctx.lineTo(strokeCapWidth + progressWidth, 0);
        return;
    }
    const steps = Math.max(Math.floor(progressWidth / 2), 10);
    for (let i = 0; i <= steps; i++) {
        const x = strokeCapWidth + (i / steps) * progressWidth;
        const waveX = ((x + waveOffset * wavelength) / wavelength) * 2 * Math.PI;
        const y = Math.sin(waveX) * waveHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
};

/**
 * Paint one frame. Sizes are CSS pixels on an already DPR-scaled context.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} frame
 *   width, totalHeight, effectiveHeight (height without shadow bleed), progress (0..1),
 *   heightFactor (entrance/disappearance vertical scale), amplitude (animated, 0..1),
 *   waveOffset, wavelength, strokeWidth, gapSize, stopSize, showStopIndicator,
 *   colors { indicator, track, stop }, shadow { enabled, color, blur, offsetX, offsetY }.
 */
export const drawWavyProgress = (ctx, frame) => {
    const {
        width, totalHeight, effectiveHeight, progress, heightFactor, amplitude,
        waveOffset, wavelength, strokeWidth, gapSize, stopSize, showStopIndicator,
        colors, shadow,
    } = frame;

    ctx.clearRect(0, 0, width, totalHeight);
    if (heightFactor <= 0) return;

    const strokeCapWidth = strokeWidth / 2;
    const halfHeight = totalHeight / 2;
    const progressWidth = progress * (width - strokeCapWidth * 2);
    const progressFrontX = strokeCapWidth + progressWidth;

    // Track and progress are scaled vertically around the centre line.
    ctx.save();
    ctx.translate(0, halfHeight);
    ctx.scale(1, heightFactor);

    clearShadow(ctx);
    ctx.strokeStyle = colors.track;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    strokeTrack(ctx, { width, progress, progressFrontX, strokeCapWidth, gapSize });

    if (progress > 0) {
        ctx.strokeStyle = colors.indicator;
        ctx.lineWidth = strokeWidth;
        ctx.lineCap = 'round';
        applyShadow(ctx, shadow);
        traceProgress(ctx, {
            progressWidth,
            strokeCapWidth,
            amplitude,
            waveHeight: amplitude * (effectiveHeight * 0.15),
            waveOffset,
            wavelength,
        });
        ctx.stroke();
        clearShadow(ctx);
    }

    ctx.restore();

    if (!showStopIndicator || progress >= 1) return;
    const stopRadius = Math.max(2, Math.min(effectiveHeight * 0.3, stopSize / 2));
    const stopX = width - strokeCapWidth;
    if (progressFrontX >= stopX - stopRadius) return;
    applyShadow(ctx, shadow);
    ctx.fillStyle = colors.stop;
    ctx.beginPath();
    ctx.arc(stopX, halfHeight, stopRadius, 0, 2 * Math.PI);
    ctx.fill();
    clearShadow(ctx);
};
