-- Some early native scenes omitted properties whose runtime value came from the default object.
-- Migration 0013 intentionally required explicit values, so those otherwise untouched scenes were
-- skipped. Treat an absent property as its runtime default while still rejecting every explicit
-- customization; this migration also repairs databases that already advanced through 0013.
UPDATE project_render_scenes
SET scene_json = json_set(scene_json, '$.customization.fontSize', 48),
    scene_revision = scene_revision + 1
WHERE json_extract(scene_json, '$.customization.fontSize') = 28
  AND json_extract(scene_json, '$.customization.fontFamily') IN (
    '''Arial'', sans-serif',
    'Arial, sans-serif',
    '''Google Sans'', sans-serif',
    'Google Sans, sans-serif'
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
  AND COALESCE(json_extract(scene_json, '$.customization.borderWidth'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.textShadowEnabled'), 1) = 1
  AND COALESCE(json_extract(scene_json, '$.customization.glowEnabled'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.gradientEnabled'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.strokeEnabled'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.multiShadowEnabled'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.pulseEnabled'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.shakeEnabled'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.position'), 'bottom') = 'bottom'
  AND COALESCE(json_extract(scene_json, '$.customization.marginBottom'), 80) = 80
  AND COALESCE(json_extract(scene_json, '$.customization.marginTop'), 80) = 80
  AND COALESCE(json_extract(scene_json, '$.customization.marginLeft'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.marginRight'), 0) = 0
  AND COALESCE(json_extract(scene_json, '$.customization.maxWidth'), 80) = 80
  AND COALESCE(json_extract(scene_json, '$.customization.fadeInDuration'), 0.3) = 0.3
  AND COALESCE(json_extract(scene_json, '$.customization.fadeOutDuration'), 0.3) = 0.3
  AND COALESCE(json_extract(scene_json, '$.customization.animationType'), 'fade') = 'fade'
  AND COALESCE(json_extract(scene_json, '$.customization.wordWrap'), 1) = 1
  AND COALESCE(json_extract(scene_json, '$.customization.maxLines'), 3) = 3
  AND COALESCE(json_extract(scene_json, '$.customization.preset'), 'default') = 'default';
