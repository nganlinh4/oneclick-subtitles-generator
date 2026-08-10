import { useTranslation } from 'react-i18next';
import CustomDropdown from './common/CustomDropdown';
import StandardSlider from './common/StandardSlider';

/**
 * Canvas settings pill shown over the crop overlay when the crop introduces
 * padding (i.e. extends beyond the source video bounds). Lets the user pick a
 * solid color or blurred-video canvas background. Pure UI — all state lives in
 * the parent and is updated through the provided callbacks.
 *
 * @param {Object} props
 * @param {Object} props.tempCrop - the working (display-space) crop object.
 * @param {Function} props.setTempCrop - setter for tempCrop.
 * @param {Function} props.onCropChange - notifies the consumer with the logical crop.
 * @param {Function} props.fromDisplayCrop - maps display-space crop -> logical crop.
 */
const CanvasSettingsPill = ({ tempCrop, setTempCrop, onCropChange, fromDisplayCrop }) => {
  const { t } = useTranslation();

  // Only render when the crop produces padding outside the video bounds
  const hasPadding = !!(tempCrop && (
    tempCrop.width > 100 || tempCrop.height > 100 || tempCrop.x < 0 || tempCrop.y < 0 ||
    (tempCrop.x + tempCrop.width) > 100 || (tempCrop.y + tempCrop.height) > 100
  ));
  if (!hasPadding) return null;

  const bgMode = tempCrop.canvasBgMode ?? 'solid';

  return (
    <div className="canvas-settings-pill" style={{
      position: 'absolute',
      bottom: '72px',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      gap: '8px',
      alignItems: 'center',
      background: 'var(--md-surface)',
      color: 'var(--md-on-surface)',
      border: '1px solid var(--md-outline-variant)',
      borderRadius: '999px',
      padding: '6px 18px',
      whiteSpace: 'nowrap',
      boxShadow: 'var(--md-elevation-level2)',
      zIndex: 20
    }}>
      <span style={{ fontSize: 12, opacity: 0.8 }}>{t('videoRendering.canvas','Canvas')}:</span>
      <CustomDropdown
        value={bgMode}
        onChange={(value) => {
          const next = { ...tempCrop, canvasBgMode: value };
          setTempCrop(next);
          onCropChange(fromDisplayCrop(next));
        }}
        options={[
          { value: 'solid', label: t('videoRendering.solidCanvas','Solid') },
          { value: 'blur', label: t('videoRendering.blurredVideo','Blurred video') },
        ]}
      />
      {bgMode === 'solid' && (
        <input
          type="color"
          value={tempCrop.canvasBgColor ?? '#000000'}
          onChange={(e) => {
            const next = { ...tempCrop, canvasBgColor: e.target.value };
            setTempCrop(next);
            onCropChange(fromDisplayCrop(next));
          }}
          title={t('videoRendering.canvasColor','Canvas color')}
          className="color-picker"
        />
      )}
      {bgMode === 'blur' && (
        <div className="canvas-blur-slider no-ui-drag" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'default' }} onMouseDown={(e) => e.stopPropagation()}>
          <span style={{ fontSize: 12, opacity: 0.8 }}>{t('videoRendering.blurIntensity', 'Blur')}</span>
          <StandardSlider
            value={tempCrop.canvasBgBlur ?? 24}
            onChange={(value) => {
              const next = { ...tempCrop, canvasBgBlur: parseInt(value) };
              setTempCrop(next);
              onCropChange(fromDisplayCrop(next));
            }}
            min={0}
            max={60}
            step={1}
            orientation="Horizontal"
            size="XSmall"
            state="Enabled"
            showValueIndicator={false}
            showIcon={false}
            showStops={false}
            style={{ width: 140 }}
            ariaLabel={t('videoRendering.blurIntensity', 'Blur')}
          />
          <span style={{ fontSize: 12, opacity: 0.7, minWidth: 28, textAlign: 'right' }}>
            {(tempCrop.canvasBgBlur ?? 24)}px
          </span>
        </div>
      )}
    </div>
  );
};

export default CanvasSettingsPill;
