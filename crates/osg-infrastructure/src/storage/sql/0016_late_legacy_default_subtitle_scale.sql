-- Migrations 0013/0014 repaired rows that existed when the database opened. A browser-era style
-- can instead remain in localStorage until a project is activated, then be materialized after those
-- one-shot migrations have already run. Repair that late-created, exact default fingerprint. The
-- frontend consumption boundary now prevents new rows of this shape; this migration closes the
-- rows produced by affected builds.
UPDATE project_render_scenes
SET scene_json = json_set(scene_json, '$.customization.fontSize', 48),
    scene_revision = scene_revision + 1
WHERE json_extract(scene_json, '$.customization.fontSize') = 28
  AND json_extract(scene_json, '$.customization.fontFamily') IN (
    '''Arial'', sans-serif', 'Arial, sans-serif',
    '''Google Sans'', sans-serif', 'Google Sans, sans-serif'
  )
  AND COALESCE(json_extract(scene_json, '$.customization.fontWeight'), 400) = 400
  AND COALESCE(json_extract(scene_json, '$.customization.textColor'), '#ffffff') = '#ffffff'
  AND COALESCE(json_extract(scene_json, '$.customization.textAlign'), 'center') = 'center'
  AND COALESCE(json_extract(scene_json, '$.customization.lineHeight'), 1.2) = 1.2
  AND COALESCE(json_extract(scene_json, '$.customization.letterSpacing'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.backgroundColor'), '#000000') = '#000000'
  AND COALESCE(json_extract(scene_json, '$.customization.backgroundOpacity'), 70) = 70
  AND COALESCE(json_extract(scene_json, '$.customization.backgroundPaddingX'), 16) = 16
  AND COALESCE(json_extract(scene_json, '$.customization.backgroundPaddingY'), 8) = 8
  AND COALESCE(json_extract(scene_json, '$.customization.borderRadius'), 4) = 4
  AND COALESCE(json_extract(scene_json, '$.customization.borderWidth'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.borderColor'), '#ffffff') = '#ffffff'
  AND COALESCE(json_extract(scene_json, '$.customization.borderStyle'), 'none') = 'none'
  AND COALESCE(json_extract(scene_json, '$.customization.textShadowEnabled'), 1) = 1
  AND COALESCE(json_extract(scene_json, '$.customization.textShadowColor'), '#000000') = '#000000'
  AND COALESCE(json_extract(scene_json, '$.customization.textShadowBlur'), 4) = 4
  AND COALESCE(json_extract(scene_json, '$.customization.textShadowOffsetX'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.textShadowOffsetY'), 2) = 2
  AND COALESCE(json_extract(scene_json, '$.customization.glowEnabled'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.glowColor'), '#ffffff') = '#ffffff'
  AND COALESCE(json_extract(scene_json, '$.customization.glowIntensity'), 10) = 10
  AND COALESCE(json_extract(scene_json, '$.customization.gradientEnabled'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.gradientType'), 'linear') = 'linear'
  AND COALESCE(json_extract(scene_json, '$.customization.gradientDirection'), '45deg') = '45deg'
  AND COALESCE(json_extract(scene_json, '$.customization.gradientColorStart'), '#ffffff') = '#ffffff'
  AND COALESCE(json_extract(scene_json, '$.customization.gradientColorEnd'), '#cccccc') = '#cccccc'
  AND COALESCE(json_extract(scene_json, '$.customization.gradientColorMid'), '#eeeeee') = '#eeeeee'
  AND COALESCE(json_extract(scene_json, '$.customization.strokeEnabled'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.strokeWidth'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.strokeColor'), '#000000') = '#000000'
  AND COALESCE(json_extract(scene_json, '$.customization.multiShadowEnabled'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.shadowLayers'), 1) = 1
  AND COALESCE(json_extract(scene_json, '$.customization.pulseEnabled'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.pulseSpeed'), 1) = 1
  AND COALESCE(json_extract(scene_json, '$.customization.shakeEnabled'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.shakeIntensity'), 2) = 2
  AND COALESCE(json_extract(scene_json, '$.customization.position'), 'bottom') = 'bottom'
  AND COALESCE(json_extract(scene_json, '$.customization.customPositionX'), 50) = 50
  AND COALESCE(json_extract(scene_json, '$.customization.customPositionY'), 80) = 80
  AND COALESCE(json_extract(scene_json, '$.customization.marginBottom'), 80) = 80
  AND COALESCE(json_extract(scene_json, '$.customization.marginTop'), 80) = 80
  AND COALESCE(json_extract(scene_json, '$.customization.marginLeft'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.marginRight'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.maxWidth'), 80) = 80
  AND COALESCE(json_extract(scene_json, '$.customization.fadeInDuration'), 0.3) = 0.3
  AND COALESCE(json_extract(scene_json, '$.customization.fadeOutDuration'), 0.3) = 0.3
  AND COALESCE(json_extract(scene_json, '$.customization.animationType'), 'fade') = 'fade'
  AND COALESCE(json_extract(scene_json, '$.customization.animationEasing'), 'ease') = 'ease'
  AND COALESCE(json_extract(scene_json, '$.customization.wordWrap'), 1) = 1
  AND COALESCE(json_extract(scene_json, '$.customization.maxLines'), 3) = 3
  AND COALESCE(json_extract(scene_json, '$.customization.lineBreakBehavior'), 'auto') = 'auto'
  AND COALESCE(json_extract(scene_json, '$.customization.rtlSupport'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.preset'), 'default') = 'default';
