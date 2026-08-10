import LiquidGlass from "../common/LiquidGlass";
import LoadingIndicator from "../common/LoadingIndicator";

/**
 * Computes the visibility-driven opacity / pointerEvents pair shared by every
 * top-side video control button.
 */
export const getVideoControlVisibilityStyle = ({
  isFullscreen,
  controlsVisible,
  isVideoHovered,
}) => {
  const isVisible = isFullscreen
    ? controlsVisible
    : isVideoHovered || controlsVisible;

  return {
    opacity: isVisible ? 1 : 0,
    transition: "opacity 0.6s ease-in-out",
    pointerEvents: isVisible ? "auto" : "none",
  };
};

/**
 * Reusable LiquidGlass video-control button used in both the left and right
 * top-side groups. Pure presentational component — all behavior is supplied
 * via props.
 *
 * @param {Object} props
 * @param {boolean} props.isLoading - When true, shows the spinner + loading label.
 * @param {string} props.icon - Material symbol name shown in the idle state.
 * @param {string} props.label - Text shown next to the icon in the idle state.
 * @param {string} [props.loadingLabel] - Text shown next to the spinner while loading.
 * @param {Function} props.onClick - Click handler.
 * @param {boolean} [props.disabled] - Disables the underlying LiquidGlass.
 * @param {string} props.themeClassName - Theme + shape classes for the LiquidGlass.
 * @param {string} props.ariaLabel - aria-label for the control.
 * @param {Object} props.visibilityStyle - Result of getVideoControlVisibilityStyle.
 * @param {number} [props.effectIntensity]
 * @param {boolean} [props.animateOnHover]
 * @param {string} [props.cursor]
 * @param {number} [props.iconSize] - Idle-state icon font size.
 * @param {number} [props.spinnerSize] - Loading-state spinner size.
 * @param {string} [props.spinnerClassName] - className for the loading spinner.
 * @param {string} [props.contentGap] - Gap between icon/spinner and label.
 * @param {Object} [props.contentStyleExtras] - Extra style applied to the inner content div.
 */
const VideoControlButton = ({
  isLoading = false,
  icon,
  label,
  loadingLabel,
  onClick,
  disabled,
  themeClassName,
  ariaLabel,
  visibilityStyle,
  effectIntensity = 0.6,
  animateOnHover = true,
  cursor = "pointer",
  iconSize = 20,
  spinnerSize = 20,
  spinnerClassName,
  contentGap = "8px",
  contentStyleExtras = {},
}) => {
  return (
    <LiquidGlass
      width="auto"
      height={50}
      position="relative"
      borderRadius="25px"
      className={`content-center interactive ${themeClassName} video-control`}
      cursor={cursor}
      effectIntensity={effectIntensity}
      effectRadius={0.5}
      effectWidth={0.3}
      effectHeight={0.2}
      animateOnHover={animateOnHover}
      hoverScale={1.05}
      updateOnMouseMove={false}
      aria-label={ariaLabel}
      style={visibilityStyle}
      onClick={onClick}
      disabled={disabled}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: contentGap,
          width: "100%",
          height: "100%",
          padding: "0 16px",
          ...contentStyleExtras,
        }}
      >
        {isLoading ? (
          <>
            <LoadingIndicator
              theme="light"
              showContainer={false}
              size={spinnerSize}
              className={spinnerClassName}
              style={{
                filter: "drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8))",
              }}
            />
            <span
              style={{
                color: "white",
                fontSize: "13px",
                fontWeight: "600",
                textShadow: "0 1px 2px rgba(0, 0, 0, 0.8)",
              }}
            >
              {loadingLabel}
            </span>
          </>
        ) : (
          <>
            <span
              className="material-symbols-rounded"
              style={{
                color: "white",
                fontSize: iconSize,
                textShadow: "0 1px 2px rgba(0, 0, 0, 0.8)",
                display: "inline-block",
              }}
            >
              {icon}
            </span>
            <span
              style={{
                color: "white",
                fontSize: "13px",
                fontWeight: "600",
                textShadow: "0 1px 2px rgba(0, 0, 0, 0.8)",
              }}
            >
              {label}
            </span>
          </>
        )}
      </div>
    </LiquidGlass>
  );
};

export default VideoControlButton;
