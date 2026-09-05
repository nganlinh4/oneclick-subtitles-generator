-- The native renderer authors subtitle sizes against a 1080px composition. The old editor preview
-- interpreted the untouched 28px default directly in its much smaller CSS viewport, so migrating
-- that value unchanged made existing default projects visibly shrink even though new projects had
-- already moved to 48px. Upgrade only the complete legacy-default fingerprint: a project with any
-- deliberate style change, or any non-default size, is user data and must remain byte-for-byte.
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
  AND json_extract(scene_json, '$.customization.fontWeight') = 400
  AND json_extract(scene_json, '$.customization.textColor') = '#ffffff'
  AND json_extract(scene_json, '$.customization.textAlign') = 'center'
  AND json_extract(scene_json, '$.customization.lineHeight') = 1.2
  AND json_extract(scene_json, '$.customization.letterSpacing') = 0
  AND json_extract(scene_json, '$.customization.backgroundColor') = '#000000'
  AND json_extract(scene_json, '$.customization.backgroundOpacity') = 70
  AND json_extract(scene_json, '$.customization.backgroundPaddingX') = 16
  AND json_extract(scene_json, '$.customization.backgroundPaddingY') = 8
  AND json_extract(scene_json, '$.customization.borderWidth') = 0
  AND json_extract(scene_json, '$.customization.textShadowEnabled') = 1
  AND json_extract(scene_json, '$.customization.glowEnabled') = 0
  AND json_extract(scene_json, '$.customization.gradientEnabled') = 0
  AND json_extract(scene_json, '$.customization.strokeEnabled') = 0
  AND json_extract(scene_json, '$.customization.multiShadowEnabled') = 0
  AND json_extract(scene_json, '$.customization.pulseEnabled') = 0
  AND json_extract(scene_json, '$.customization.shakeEnabled') = 0
  AND json_extract(scene_json, '$.customization.position') = 'bottom'
  AND json_extract(scene_json, '$.customization.marginBottom') = 80
  AND json_extract(scene_json, '$.customization.marginTop') = 80
  AND json_extract(scene_json, '$.customization.marginLeft') = 0
  AND json_extract(scene_json, '$.customization.marginRight') = 0
  AND json_extract(scene_json, '$.customization.maxWidth') = 80
  AND json_extract(scene_json, '$.customization.fadeInDuration') = 0.3
  AND json_extract(scene_json, '$.customization.fadeOutDuration') = 0.3
  AND json_extract(scene_json, '$.customization.animationType') = 'fade'
  AND json_extract(scene_json, '$.customization.wordWrap') = 1
  AND json_extract(scene_json, '$.customization.maxLines') = 3
  AND json_extract(scene_json, '$.customization.preset') = 'default';
