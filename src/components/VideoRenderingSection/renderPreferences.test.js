import {
  DEFAULT_CROP_SETTINGS,
  DEFAULT_RENDER_SETTINGS,
  consumeLegacyRenderScene,
  loadCropSettings,
  loadNarrationSource,
  loadPanelWidth,
  loadRenderSettings,
  loadSubtitleSource,
  storeRenderPreference,
} from './renderPreferences';

const storageWith = (values = {}) => ({
  getItem: vi.fn((key) => values[key] ?? null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
});

describe('video rendering preferences', () => {
  it('recovers complete defaults from malformed JSON and storage failures', () => {
    const malformed = storageWith({
      videoRender_renderSettings: '{bad',
      videoRender_cropSettings: '[]',
      videoRender_selectedSubtitles: 'foreign',
      videoRender_selectedNarration: 'foreign',
      videoRender_leftPanelWidth: 'NaN',
    });
    expect(loadRenderSettings(malformed)).toEqual(DEFAULT_RENDER_SETTINGS);
    expect(loadCropSettings(malformed)).toEqual(DEFAULT_CROP_SETTINGS);
    expect(loadSubtitleSource(malformed)).toBe('original');
    expect(loadNarrationSource(malformed)).toBe('none');
    expect(loadPanelWidth(malformed)).toBe(66.67);

    const blocked = { getItem: () => { throw new Error('blocked'); } };
    expect(loadRenderSettings(blocked)).toEqual(DEFAULT_RENDER_SETTINGS);
    expect(loadCropSettings(blocked)).toEqual(DEFAULT_CROP_SETTINGS);
    expect(loadPanelWidth(blocked)).toBe(66.67);
  });

  it('keeps valid render fields while replacing invalid and unknown fields', () => {
    const storage = storageWith({
      videoRender_renderSettings: JSON.stringify({
        resolution: '720p',
        frameRate: 60,
        videoType: 'other',
        originalAudioVolume: 25,
        narrationVolume: 101,
        trimStart: 10,
        trimEnd: 9,
        sourcePath: 'C:\\private\\clip.mp4',
      }),
    });
    expect(loadRenderSettings(storage)).toEqual({
      ...DEFAULT_RENDER_SETTINGS,
      resolution: '720p',
      frameRate: 60,
      originalAudioVolume: 25,
    });
  });

  it('keeps exact valid crop fields while replacing invalid and unknown fields', () => {
    const storage = storageWith({
      videoRender_cropSettings: JSON.stringify({
        x: -100,
        y: 25,
        width: 150,
        height: 0,
        aspectRatio: 16 / 9,
        canvasBgMode: 'blur',
        canvasBgColor: '#1234',
        canvasBgBlur: 48,
        flipX: true,
        flipY: 'yes',
        nativePath: 'C:\\private\\clip.mp4',
      }),
    });
    expect(loadCropSettings(storage)).toEqual({
      ...DEFAULT_CROP_SETTINGS,
      x: -100,
      y: 25,
      width: 150,
      aspectRatio: 16 / 9,
      canvasBgMode: 'blur',
      canvasBgColor: '#1234',
      canvasBgBlur: 48,
      flipX: true,
    });
  });

  it('accepts only closed subtitle, narration, and panel-width choices', () => {
    const storage = storageWith({
      videoRender_selectedSubtitles: 'translated',
      videoRender_selectedNarration: 'generated',
      videoRender_leftPanelWidth: '72.5',
    });
    expect(loadSubtitleSource(storage)).toBe('translated');
    expect(loadNarrationSource(storage)).toBe('generated');
    expect(loadPanelWidth(storage)).toBe(72.5);
  });

  it('writes text and JSON without allowing storage or serialization failures to escape', () => {
    const storage = storageWith();
    expect(storeRenderPreference('text', 'value', { storage })).toBe(true);
    expect(storeRenderPreference('json', { value: 1 }, { json: true, storage })).toBe(true);
    expect(storage.setItem).toHaveBeenNthCalledWith(1, 'text', 'value');
    expect(storage.setItem).toHaveBeenNthCalledWith(2, 'json', '{"value":1}');

    const blocked = { setItem: () => { throw new Error('blocked'); } };
    expect(storeRenderPreference('text', 'value', { storage: blocked })).toBe(false);
    const cyclic = {};
    cyclic.self = cyclic;
    expect(storeRenderPreference('json', cyclic, { json: true, storage })).toBe(false);
  });

  it('consumes the project-less editor style once when no render-tab scene existed', () => {
    const storage = storageWith({
      subtitle_settings: JSON.stringify({
        fontSize: '72',
        position: '25',
        opacity: '0.5',
        showTranslatedSubtitles: true,
      }),
      subtitle_language: 'translated',
    });
    expect(consumeLegacyRenderScene(storage)).toMatchObject({
      selectedSubtitles: 'translated',
      selectedNarration: 'none',
      customization: {
        fontSize: 72,
        position: 'custom',
        customPositionY: 25,
        backgroundOpacity: 50,
      },
    });
    expect(storage.removeItem).toHaveBeenCalledWith('subtitle_settings');
    expect(storage.removeItem).toHaveBeenCalledWith('subtitle_language');
  });

  it('prefers the more complete render-tab style when both legacy stores disagree', () => {
    const storage = storageWith({
      videoRender_subtitleCustomization: JSON.stringify({ fontSize: 64 }),
      videoRender_selectedSubtitles: 'original',
      subtitle_settings: JSON.stringify({ fontSize: '99', showTranslatedSubtitles: true }),
    });
    expect(consumeLegacyRenderScene(storage)).toMatchObject({
      selectedSubtitles: 'original',
      customization: { fontSize: 64 },
    });
  });

  it('upgrades only untouched browser-era 28px defaults during late localStorage consumption', () => {
    const untouchedRenderDefault = storageWith({
      videoRender_subtitleCustomization: JSON.stringify({ fontSize: 28 }),
    });
    expect(consumeLegacyRenderScene(untouchedRenderDefault).customization.fontSize).toBe(48);

    const untouchedEditorDefault = storageWith({
      subtitle_settings: JSON.stringify({ fontSize: '28' }),
    });
    expect(consumeLegacyRenderScene(untouchedEditorDefault).customization.fontSize).toBe(48);

    const intentionalTwentyEight = storageWith({
      videoRender_subtitleCustomization: JSON.stringify({
        fontSize: 28,
        textColor: '#ff00ff',
      }),
    });
    expect(consumeLegacyRenderScene(intentionalTwentyEight).customization).toMatchObject({
      fontSize: 28,
      textColor: '#ff00ff',
    });
  });

  it('refuses an unreadable or undeletable legacy scene instead of silently skipping it', () => {
    const unreadable = { getItem: () => { throw new Error('blocked read'); } };
    expect(() => consumeLegacyRenderScene(unreadable)).toThrow(expect.objectContaining({
      name: 'LegacyRenderSceneConsumptionError',
      code: 'legacyRenderSceneConsumptionFailed',
    }));

    const undeletable = storageWith({
      videoRender_selectedSubtitles: 'translated',
    });
    undeletable.removeItem.mockImplementation(() => { throw new Error('blocked delete'); });
    expect(() => consumeLegacyRenderScene(undeletable)).toThrow(expect.objectContaining({
      name: 'LegacyRenderSceneConsumptionError',
      code: 'legacyRenderSceneConsumptionFailed',
    }));
  });
});
