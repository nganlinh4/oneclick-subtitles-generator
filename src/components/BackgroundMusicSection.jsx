import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../styles/CollapsibleSection.css';
import '../styles/BackgroundMusicSection.css';
import '../styles/components/panel-resizer.css';

import { useTranslation } from 'react-i18next';
import {
  getActiveGeminiCredentialId,
  initializeCredentialState,
  subscribeCredentialState,
} from '../platform/credentialStateController';
import CustomDropdown from './common/CustomDropdown';
import MaterialSwitch from './common/MaterialSwitch';
import HelpIcon from './common/HelpIcon.jsx';
import AudioPlayer from './common/AudioPlayer';
import { formatTime } from '../utils/timeFormatter';
import { startPromptDjReadinessBridge } from './backgroundMusic/promptDjReadiness';
import useResizablePanelHeight from './backgroundMusic/useResizablePanelHeight';
import usePromptDjAppearanceSync, {
  postCurrentFont,
  postCurrentTheme,
} from './backgroundMusic/usePromptDjAppearanceSync';
import usePromptDjBridge from './backgroundMusic/usePromptDjBridge';
import useLiveMusicSession from './backgroundMusic/useLiveMusicSession';
import useBackgroundMusicRecording from './backgroundMusic/useBackgroundMusicRecording';
import {
  readPreference,
  readStoredPreference,
  writePreference,
} from '../platform/preferences/store';

// Collapsible section embedding the promptdj-midi app with start/stop recording controls
const BackgroundMusicSection = () => {
  const { t, i18n } = useTranslation();
  const iframeRef = useRef(null);

  const [isCollapsed, setIsCollapsed] = useState(() => readPreference('bg_music_collapsed'));

  const {
    panelRef,
    panelHeight,
    isResizing,
    onResizePointerDown,
    resetPanelHeight,
  } = useResizablePanelHeight();

  // MIDI UI state now lives in the main app header
  const [midiShow, setMidiShow] = useState(false);
  const [midiInputs, setMidiInputs] = useState([]); // [{id, name}]
  const [activeMidiId, setActiveMidiId] = useState('');

  const promptDjOrigin = useMemo(() => window.location.origin, []);
  const midiAppUrl = useMemo(
    () => new URL('/promptdj/index.html', window.location.origin).href,
    []
  );

  const getPromptDjWindow = useCallback(() => {
    try {
      return iframeRef.current?.contentWindow || null;
    } catch {
      return null;
    }
  }, []);

  const postToPromptDj = useCallback((message, transfer = []) => {
    const target = getPromptDjWindow();
    if (!target) return;
    try { target.postMessage(message, promptDjOrigin, transfer); } catch {
      // The iframe may be navigating or already destroyed.
    }
  }, [getPromptDjWindow, promptDjOrigin]);

  const postNativeAvailability = useCallback(async () => {
    try {
      await initializeCredentialState();
      const available = getActiveGeminiCredentialId() !== null;
      postToPromptDj({ type: 'pm-dj-native-init', available });
      return available;
    } catch {
      postToPromptDj({ type: 'pm-dj-native-init', available: false });
      return false;
    }
  }, [postToPromptDj]);

  const postResetToIframe = useCallback(() => {
    postToPromptDj({ type: 'pm-dj-reset' });
  }, [postToPromptDj]);

  const recording = useBackgroundMusicRecording({ getPromptDjWindow, postToPromptDj });
  const {
    isRecording,
    recordingUrl,
    recordingBlob,
    elapsed,
    startRecording,
    stopRecording,
    clearRecording: clearReferenceAudio,
  } = recording;
  const liveMusic = useLiveMusicSession({ postToPromptDj });

  const onMidiInputs = useCallback(({ inputs, activeId, show }) => {
    setMidiInputs(inputs);
    if (activeId !== undefined) setActiveMidiId(activeId);
    if (show !== undefined) setMidiShow(show);
  }, []);

  usePromptDjBridge({
    getPromptDjWindow,
    promptDjOrigin,
    handlers: {
      ...liveMusic,
      onRecordingStarted: recording.onRecordingStarted,
      onRecordingStopped: recording.onRecordingStopped,
      onRecordingError: recording.onRecordingError,
      onMidiInputs,
    },
  });

  // Propagate language changes to iframe
  useEffect(() => {
    const lang = (typeof i18n?.language === 'string' && i18n.language) ? i18n.language : (readStoredPreference('preferred_language') || 'en');
    postToPromptDj({ type: 'pm-dj-set-lang', lang });
  }, [i18n?.language, postToPromptDj]);

  const onIframeLoad = useCallback(() => {
    postNativeAvailability();
    // Sync theme initially
    postCurrentTheme(postToPromptDj);
    // Sync font initially
    postCurrentFont(postToPromptDj);
    // Request current MIDI inputs/state
    postToPromptDj({ type: 'midi:getInputs' });

    // Prevent iframe from stealing focus on load
    setTimeout(() => {
      try {
        if (iframeRef.current && document.activeElement === iframeRef.current) {
          iframeRef.current.blur();
        }
      } catch {
        // Focus restoration is best effort after iframe initialization.
      }
    }, 100);
  }, [postNativeAvailability, postToPromptDj]);

  usePromptDjAppearanceSync(postToPromptDj);

  useEffect(() => {
    const unsubscribe = subscribeCredentialState(() => {
      postNativeAvailability();
    });
    postNativeAvailability();
    return unsubscribe;
  }, [postNativeAvailability]);

  useEffect(() => {
    if (isCollapsed) return undefined;
    return startPromptDjReadinessBridge({
      isReady: () => {
        try {
          const target = getPromptDjWindow();
          const host = target?.document?.querySelector('prompt-dj-midi');
          return host !== null && host !== undefined
            && typeof host.credentialAvailable === 'boolean';
        } catch {
          return false;
        }
      },
      publish: postNativeAvailability,
    });
  }, [getPromptDjWindow, isCollapsed, postNativeAvailability]);

  return (
    <div
      className={`music-generator-section ${isCollapsed ? 'collapsed' : 'expanded'}`}
    >
      {/* Header */}
      <div className="music-generator-header">
        <div className="header-left" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 36, flexWrap: 'wrap' }}>
          {isCollapsed && (
            <h2 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <span className="material-symbols-rounded" style={{ fontSize: '24px' }}>music_note</span>
              {t('backgroundMusic.title', 'Background Music Generator')}
            </h2>
          )}

          {/* MIDI controls in header - hidden when collapsed */}
          {!isCollapsed && (
            <div className="midi-controls" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <MaterialSwitch
                  checked={midiShow}
                  onChange={(e) => {
                    const show = !!e?.target?.checked;
                    setMidiShow(show);
                    postToPromptDj({ type: 'midi:setShow', show });
                    if (show) {
                      postToPromptDj({ type: 'midi:getInputs' });
                    }
                  }}
                  ariaLabel={t('backgroundMusic.midi', 'MIDI')}
                  icons={true}
                />
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: '18px' }}>piano</span>
                  MIDI
                </span>
              </div>

              <CustomDropdown
                value={activeMidiId || ''}
                onChange={(nextId) => {
                  setActiveMidiId(nextId);
                  postToPromptDj({ type: 'midi:setActiveInput', id: nextId });
                }}
                options={(midiInputs || []).map(({ id, name }) => ({ value: id, label: name || id }))}
                placeholder={t('backgroundMusic.noDevices', 'Không tìm thấy thiết bị')}
                disabled={!midiShow}
              />
            </div>
          )}

          {/* Record/Stop button with timer and download inline with title; hidden when collapsed */}
          {!isCollapsed && (
            <div className="header-controls" style={{ display: 'flex', alignItems: 'center', gap: 16, minHeight: 40 }}>
              {!isRecording ? (
                <button
                  className="pill-button primary"
                  onClick={startRecording}
                  title={t('narration.record', 'Record')}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>radio_button_checked</span>
                  {t('narration.record', 'Record')}
                </button>
              ) : (
                <button
                  className="pill-button error"
                  onClick={stopRecording}
                  title={t('narration.stopRecording', 'Stop')}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>stop</span>
                  {t('narration.stopRecording', 'Stop')} {formatTime(elapsed, 'hms_ms')}
                </button>
              )}

              {/* Inline audio preview when available (match narration styles) */}
              {recordingUrl && (
                <div className="audio-preview" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <AudioPlayer audioSrc={recordingUrl} referenceAudio={{ filename: 'background_music.wav', blob: recordingBlob }} height={18} style={{ width: '-webkit-fill-available' }} />
                  <button
                    className="pill-button error clear-button"
                    onClick={clearReferenceAudio}
                    title={t('narration.clearReference', 'Clear reference audio')}
                  >
                    <span aria-hidden="true" className="material-symbols-rounded" style={{ fontSize: '14px' }}>close</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Help icon to the right of header-controls when expanded */}
          {!isCollapsed && (
            <HelpIcon
              title={t('backgroundMusic.helperMessage', 'Create DJ‑style live music and record it.')}
              style={{ cursor: 'help', color: 'var(--md-on-surface-variant)', opacity: 0.9 }}
            />
          )}
        </div>
        <button
          className="collapse-button"
          onClick={() => {
            const next = !isCollapsed;
            setIsCollapsed(next);
            writePreference('bg_music_collapsed', next);
          }}
          aria-label={isCollapsed ? t('common.expand', 'Expand') : t('common.collapse', 'Collapse')}
          aria-expanded={!isCollapsed}
        >
          <span aria-hidden="true" className="material-symbols-rounded">{isCollapsed ? 'expand_more' : 'stat_1'}</span>
        </button>
      </div>

      {/* Collapsed content */}
      {isCollapsed ? (
        <div className="music-generator-collapsed-content">
          <p className="helper-message">
            {t('backgroundMusic.sectionMessage', 'Configure prompts inside the embedded app to generate live background music.')}
          </p>
        </div>
      ) : (
        <div className="music-generator-content">
          <div
            ref={panelRef}
            style={{ position: 'relative', width: '100%', height: panelHeight, background: '#111', overflow: 'hidden' }}
         >
            <iframe
              ref={iframeRef}
              title="promptdj-midi"
              src={midiAppUrl}
              onLoad={onIframeLoad}
              allow="microphone; midi; autoplay"
              scrolling="no"
              style={{ border: 'none', width: '100%', height: '100%' }}
            />
            {isResizing && (
              <div
                style={{
                  position: 'absolute', inset: 0, cursor: 'row-resize',
                  zIndex: 10, background: 'transparent'
                }}
              />
            )}
            {/* Overlayed reset button (page bottom-left) */}
            <button
              onClick={postResetToIframe}
              title={t('common.reset', 'Reset')}
              style={{
                position: 'absolute', left: 16, bottom: 16,
                width: 40, height: 40, borderRadius: 9999,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                border: '1px solid var(--md-outline-variant)',
                background: 'var(--md-primary-container)', color: 'var(--md-on-primary-container)',
                boxShadow: 'var(--md-elevation-level2)'
              }}
            >
              <span aria-hidden="true" className="material-symbols-rounded" style={{ fontSize: '28px' }}>restart_alt</span>
            </button>

            {/* Floating resizer pill (bottom-right) */}
            <div
              className="floating-resizer-pill"
              onPointerDown={onResizePointerDown}
              onDoubleClick={resetPanelHeight}
              title={t('common.resize', 'Resize height')}
              role="separator"
              aria-orientation="vertical"
              aria-label={t('common.resize', 'Resize height')}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default BackgroundMusicSection;
