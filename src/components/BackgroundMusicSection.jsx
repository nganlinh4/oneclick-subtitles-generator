import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../styles/CollapsibleSection.css';
import '../styles/BackgroundMusicSection.css';
import '../styles/components/panel-resizer.css';

import { useTranslation } from 'react-i18next';
import { getCurrentKey } from '../services/gemini/keyManager';
import CustomDropdown from './common/CustomDropdown';
import MaterialSwitch from './common/MaterialSwitch';
import HelpIcon from './common/HelpIcon.jsx';
import { formatTime } from '../utils/timeFormatter';
import { trimSilenceFromBlob } from '../utils/audioTrim';

// Collapsible section embedding the promptdj-midi app with start/stop recording controls
const BackgroundMusicSection = () => {
  const { t, i18n } = useTranslation();
  const iframeRef = useRef(null);

  const [isRecording, setIsRecording] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState('');
  const [recordingStartTime, setRecordingStartTime] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem('bg_music_collapsed');
    return saved === 'true';
  });

  // Resizable panel height state
  const [panelHeight, setPanelHeight] = useState(() => {
    const saved = parseInt(localStorage.getItem('bg_music_panel_height') || '600', 10);
    return Number.isFinite(saved) ? saved : 600;
  });
  const panelMinHeight = 280;
  const panelMaxHeight = 1400;

  // Track active resizing to place an overlay above the iframe
  const [isResizing, setIsResizing] = useState(false);

  // MIDI UI state now lives in the main app header
  const [midiShow, setMidiShow] = useState(false);
  const [midiInputs, setMidiInputs] = useState([]); // [{id, name}]
  const [activeMidiId, setActiveMidiId] = useState('');

  const midiAppUrl = useMemo(() => 'http://127.0.0.1:3037/', []);

  // Resizer refs and handlers for panel height
  const panelRef = useRef(null);
  const resizingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  // Keep latest height in a ref to avoid stale closures
  const latestHeightRef = useRef(panelHeight);
  useEffect(() => { latestHeightRef.current = panelHeight; }, [panelHeight]);

  const endResize = useCallback(() => {
    if (!resizingRef.current) return;
    resizingRef.current = false;
    try { document.body.style.cursor = ''; document.body.style.userSelect = ''; } catch {}
    const finalH = Math.round(panelRef.current?.offsetHeight || latestHeightRef.current || 600);
    try { localStorage.setItem('bg_music_panel_height', String(finalH)); } catch {}
    // Remove all possible listeners
    window.removeEventListener('pointermove', onAnyMove);
    window.removeEventListener('pointerup', endResize);
    window.removeEventListener('pointercancel', endResize);
    window.removeEventListener('mousemove', onAnyMove);
    window.removeEventListener('mouseup', endResize);
    window.removeEventListener('touchmove', onAnyTouchMove);
    window.removeEventListener('touchend', endResize);
    window.removeEventListener('touchcancel', endResize);
    window.removeEventListener('blur', endResize);
    setIsResizing(false);
  }, []);

  const onAnyMove = useCallback((e) => {
    if (!resizingRef.current) return;
    const clientY = e.clientY ?? (e.touches && e.touches[0] && e.touches[0].clientY) ?? 0;
    const dy = clientY - startYRef.current;
    let next = startHeightRef.current + dy;
    next = Math.max(panelMinHeight, Math.min(panelMaxHeight, next));
    setPanelHeight(next);
  }, []);

  const onAnyTouchMove = useCallback((e) => onAnyMove(e), [onAnyMove]);

  function onResizePointerDown(e) {
    e.preventDefault();
    resizingRef.current = true;
    setIsResizing(true);
    startYRef.current = (e.clientY ?? (e.touches && e.touches[0] && e.touches[0].clientY) ?? 0);
    startHeightRef.current = panelRef.current?.offsetHeight || latestHeightRef.current || panelHeight;
    try { document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none'; } catch {}
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
    window.addEventListener('pointermove', onAnyMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
    window.addEventListener('mousemove', onAnyMove);
    window.addEventListener('mouseup', endResize);
    window.addEventListener('touchmove', onAnyTouchMove, { passive: false });
    window.addEventListener('touchend', endResize);
    window.addEventListener('touchcancel', endResize);
    window.addEventListener('blur', endResize);
  }

  const postApiKeyToIframe = useCallback(() => {
    const apiKey = getCurrentKey?.() || localStorage.getItem('gemini_api_key') || '';
    if (!apiKey) {
      return;
    }
    if (!iframeRef.current?.contentWindow) return;
    const lang = (typeof i18n?.language === 'string' && i18n.language) ? i18n.language : (localStorage.getItem('preferred_language') || 'en');
    iframeRef.current.contentWindow.postMessage({ type: 'pm-dj-set-api-key', apiKey, lang }, '*');
  }, [i18n]);

  const startRecording = useCallback(() => {
    if (!iframeRef.current?.contentWindow) return;
    if (recordingUrl) {
      try { URL.revokeObjectURL(recordingUrl); } catch {}
    }
    setRecordingUrl('');
    setRecordingStartTime(Date.now());
    iframeRef.current.contentWindow.postMessage({ type: 'pm-dj-start-recording' }, '*');
  }, [recordingUrl]);

  const stopRecording = useCallback(() => {
    if (!iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage({ type: 'pm-dj-stop-recording' }, '*');
  }, []);

  const clearReferenceAudio = useCallback(() => {
    if (recordingUrl) {
      try { URL.revokeObjectURL(recordingUrl); } catch {}
    }
    setRecordingUrl('');
  }, [recordingUrl]);

  // Timer like narration
  useEffect(() => {
    if (isRecording && recordingStartTime) {
      setElapsed((Date.now() - recordingStartTime) / 1000);
      const id = setInterval(() => {
        setElapsed((Date.now() - recordingStartTime) / 1000);
      }, 100);
      return () => clearInterval(id);
    } else {
      setElapsed(0);
    }
  }, [isRecording, recordingStartTime]);

	  // Cleanup object URL when it changes or on unmount
	  useEffect(() => {
	    return () => {
	      if (recordingUrl) {
	        try { URL.revokeObjectURL(recordingUrl); } catch {}
	      }
	    };
	  }, [recordingUrl]);


  // Propagate language changes to iframe
  useEffect(() => {
    if (!iframeRef.current?.contentWindow) return;
    const lang = (typeof i18n?.language === 'string' && i18n.language) ? i18n.language : (localStorage.getItem('preferred_language') || 'en');
    iframeRef.current.contentWindow.postMessage({ type: 'pm-dj-set-lang', lang }, '*');
  }, [i18n?.language]);

  // Receive messages from the iframe
  useEffect(() => {
    function onMessage(event) {
      try {
        // Accept messages from same-origin (production/preview) and local dev servers
        const allowed = new Set([
          window.location.origin,
          'http://127.0.0.1:3037',
          'http://localhost:3037',
        ]);
        if (event.origin && !allowed.has(event.origin)) return;
      } catch {}

      const data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'pm-dj-recording-started') {
        setIsRecording(true);
        setRecordingStartTime((prev) => prev ?? Date.now());
      }
      if (data.type === 'pm-dj-recording-stopped') {
        setIsRecording(false);
        // Process: trim silence seamlessly and generate new URL
        (async () => {
          try {
            if (data.blob) {
              const trimmed = await trimSilenceFromBlob(data.blob, {
                silenceThreshold: 0.004, // ~ -48 dBFS
                minSilenceMs: 180,
                analysisWindowMs: 20,
              });
              // Revoke previous URL
              if (recordingUrl) {
                try { URL.revokeObjectURL(recordingUrl); } catch {}
              }
              const finalBlob = trimmed || data.blob;
              const url = URL.createObjectURL(finalBlob);
              setRecordingUrl(url);
            }
          } catch (err) {
            // Fallback to raw blob
            try {
              if (recordingUrl) { URL.revokeObjectURL(recordingUrl); }
              if (data.blob) {
                const url = URL.createObjectURL(data.blob);
                setRecordingUrl(url);
              }
            } catch {}
          }
        })();
      }
      if (data.type === 'pm-dj-recording-error') {
        setIsRecording(false);
      }

      // MIDI bridge: receive device list/state
      if (data.type === 'midi:inputs') {
        const arr = Array.isArray(data.inputs) ? data.inputs : [];
        setMidiInputs(arr);
        if (typeof data.activeId === 'string') setActiveMidiId(data.activeId);
        if (typeof data.show === 'boolean') setMidiShow(data.show);
      }
    }


    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Send API key on iframe load and when storage changes
  const onIframeLoad = useCallback(() => {
    postApiKeyToIframe();
    // Sync theme initially
    try {
      const theme = document.documentElement.getAttribute('data-theme')
        || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      iframeRef.current?.contentWindow?.postMessage({ type: 'pm-dj-set-theme', theme }, '*');
    } catch {}
    // Request current MIDI inputs/state
    try { iframeRef.current?.contentWindow?.postMessage({ type: 'midi:getInputs' }, '*'); } catch {}
  }, [postApiKeyToIframe]);

  // Watch main app theme changes and forward to iframe
  useEffect(() => {
    const el = document.documentElement;

    const sendTheme = () => {
      try {
        const theme = el.getAttribute('data-theme')
          || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        iframeRef.current?.contentWindow?.postMessage({ type: 'pm-dj-set-theme', theme }, '*');
      } catch {}
    };

    // Initial
    sendTheme();

    // Observe attribute changes
    const observer = new MutationObserver((mutList) => {
      for (const m of mutList) {
        if (m.type === 'attributes' && m.attributeName === 'data-theme') {
          sendTheme();
          break;
        }
      }
    });
    observer.observe(el, { attributes: true, attributeFilter: ['data-theme'] });

    // Also respond to prefers-color-scheme changes if app relies on system theme
    const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const onMql = () => sendTheme();
    try { mql?.addEventListener('change', onMql); } catch { try { mql?.addListener(onMql); } catch {} }

    return () => {
      try { observer.disconnect(); } catch {}
      try { mql?.removeEventListener('change', onMql); } catch { try { mql?.removeListener(onMql); } catch {} }
    };
  }, []);

  useEffect(() => {
    const onStorage = (e) => {
      if (e && e.key && !e.key.toLowerCase().includes('gemini')) return;
      postApiKeyToIframe();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [postApiKeyToIframe]);

  return (
    <div
      className={`music-generator-section ${isCollapsed ? 'collapsed' : 'expanded'}`}
    >
      {/* Header */}
      <div className="music-generator-header">
        <div className="header-left" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 36, flexWrap: 'wrap' }}>
          {isCollapsed && (
            <h2 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 -960 960 960" width="24" fill="currentColor"><path d="M388-68q-80.49 0-137.24-56.76Q194-181.51 194-262q0-79.49 56.76-136.74Q307.51-456 388-456q15.95 0 29.48 2 13.52 2 28.52 5v-443h321v221H582v409q0 80.49-57.26 137.24Q467.49-68 388-68Z"/></svg>
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
                    try { iframeRef.current?.contentWindow?.postMessage({ type: 'midi:setShow', show }, '*'); } catch {}
                    if (show) {
                      try { iframeRef.current?.contentWindow?.postMessage({ type: 'midi:getInputs' }, '*'); } catch {}
                    }
                  }}
                  ariaLabel={t('backgroundMusic.midi', 'MIDI')}
                  icons={true}
                />
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                  <svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 -960 960 960" width="18" fill="currentColor"><path d="M212-76q-57.12 0-96.56-39.44Q76-154.88 76-212v-536q0-57.13 39.44-96.56Q154.88-884 212-884h536q57.13 0 96.56 39.44Q884-805.13 884-748v536q0 57.12-39.44 96.56Q805.13-76 748-76H212Zm0-136h95v-155h2q-22.65 0-37.33-14.67Q257-396.35 257-419v-329h-45v536Zm441 0h95v-536h-45v329q0 22.65-14.67 37.33Q673.65-367 651-367h2v155Zm-245 0h144v-155h2q-22.65 0-37.33-14.67Q502-396.35 502-419v-329h-44v330q0 22.23-14.66 36.61Q428.67-367 407-367h1v155Z"/></svg>
                  MIDI
                </span>
              </div>

              <CustomDropdown
                value={activeMidiId || ''}
                onChange={(nextId) => {
                  setActiveMidiId(nextId);
                  try { iframeRef.current?.contentWindow?.postMessage({ type: 'midi:setActiveInput', id: nextId }, '*'); } catch {}
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
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="6" fill="currentColor" />
                  </svg>
                  {t('narration.record', 'Record')}
                </button>
              ) : (
                <button
                  className="pill-button error"
                  onClick={stopRecording}
                  title={t('narration.stopRecording', 'Stop')}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="6" y="6" width="12" height="12" fill="currentColor" />
                  </svg>
                  {t('narration.stopRecording', 'Stop')} {formatTime(elapsed, 'hms_ms')}
                </button>
              )}

              {/* Download button appears when a recording is available */}
              {recordingUrl && (
                <a
                  className="pill-button secondary"
                  href={recordingUrl}
                  download={`background-music-${Date.now()}.webm`}
                  title={t('backgroundMusic.downloadRecording', 'Download recording')}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 13 7 8" />
                    <line x1="12" y1="3" x2="12" y2="13" />
                  </svg>
                  {t('narration.download', 'Download')}
                </a>
              )}

              {/* Inline audio preview when available (match narration styles) */}
              {recordingUrl && (
                <div className="audio-preview" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <div className="audio-player-container controls">
                    <audio
                      controls
                      src={recordingUrl}
                      className="audio-player"
                      tabIndex="-1"
                    >
                      {t('narration.audioNotSupported', 'Your browser does not support the audio element.')}
                    </audio>
                  </div>
                  <button
                    className="pill-button error clear-button"
                    onClick={clearReferenceAudio}
                    title={t('narration.clearReference', 'Clear reference audio')}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
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
            localStorage.setItem('bg_music_collapsed', next ? 'true' : 'false');
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
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
        <div className="music-generator-content" style={{ gap: 0 }}>
          <div
            ref={panelRef}
            style={{ position: 'relative', width: '100%', height: panelHeight, background: '#111', borderRadius: 6, overflow: 'hidden' }}
         >
            <iframe
              ref={iframeRef}
              title="promptdj-midi"
              src={midiAppUrl}
              onLoad={onIframeLoad}
              allow="midi"
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
              onClick={() => { try { iframeRef.current?.contentWindow?.postMessage({ type: 'pm-dj-reset' }, '*'); } catch {} }}
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
              <svg xmlns="http://www.w3.org/2000/svg" height="28" viewBox="0 -960 960 960" width="28" fill="currentColor"><path d="M352-96q-106-40-172-132.5T114-438q0-47 12-92t33-86q15-30 48-32.5t60 23.5q14 14 16.5 36t-8.5 42q-12 26-18.5 53.5T250-438q0 70 37.5 127t99.5 84q21 8 34.5 27t13.5 39q0 37-25.5 57T352-96Zm256 0q-32 13-57.5-7.5T525-161q0-19 13.5-38.5T573-227q61-27 99-84t38-127q0-89-58.5-155T506-667h-6l11 11q15 15 13.5 36.5T509-584q-16 15-37.5 15T434-584L324-694q-10-10-15-22.5t-5-25.5q0-13 5-25.5t15-21.5l111-112q15-15 36.5-15t37.5 15q15 16 15.5 37T511-829l-25 25h7q148 0 250.5 107.5T846-438q0 117-66 209.5T608-96Z"/></svg>
            </button>

            {/* Floating resizer pill (bottom-right) */}
            <div
              className="floating-resizer-pill"
              onPointerDown={onResizePointerDown}
              onDoubleClick={() => {
                const def = 600;
                setPanelHeight(def);
                try { localStorage.setItem('bg_music_panel_height', String(def)); } catch {}
              }}
              title={t('common.resize', 'Resize height')}
              role="separator"
              aria-orientation="vertical"
              aria-label={t('common.resize', 'Resize height')}
            />
          </div>
          {/* Horizontal resizer handle */}

        </div>
      )}
    </div>
  );
};

export default BackgroundMusicSection;
