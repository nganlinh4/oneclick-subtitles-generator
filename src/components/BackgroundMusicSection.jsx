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

  const midiAppUrl = useMemo(() => {
    const isDev = process.env.NODE_ENV !== 'production';
    if (isDev) return 'http://127.0.0.1:3037/';
    const v = process.env.REACT_APP_GIT_VERSION || process.env.REACT_APP_VERSION || '';
    return `/promptdj-midi/index.html${v ? `?v=${encodeURIComponent(v)}` : ''}`;
  }, []);

  // Build a same-origin wrapper page that embeds the remote promptdj app and
  // implements mic recording + message relay. This ensures we can permanently
  // request mic permission and relay blobs even if the inner app doesn't.
  const wrapperHtml = useMemo(() => {
    const innerSrc = midiAppUrl;
    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#111;color:#eee;">
  <iframe id="inner" title="promptdj-inner" src="${innerSrc}" allow="microphone; midi; autoplay" style="border:0;width:100%;height:100vh"></iframe>
  <script>
  (function(){
    const inner = document.getElementById('inner');
    let recStream = null; let mr = null; let chunks = []; let isRecording = false;

    function postUp(msg){ try { window.parent && window.parent.postMessage(msg, '*'); } catch(e){} }
    function postDown(msg){ try { inner.contentWindow && inner.contentWindow.postMessage(msg, '*'); } catch(e){} }

    async function requestMicOnce(){
      // Prompt user for mic permission without keeping the stream active
      let s;
      try {
        s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (e) {
        postUp({ type: 'pm-dj-recording-error', error: { name: e.name, message: e.message } });
        throw e;
      } finally {
        try { s && s.getTracks().forEach(t => t.stop()); } catch {}
      }
    }

    async function startRec(){
      if (isRecording) return;
      try {
        recStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        chunks = [];
        let opts = {};
        if (window.MediaRecorder && MediaRecorder.isTypeSupported){
          const cand = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg'];
          const mt = cand.find(c => MediaRecorder.isTypeSupported(c));
          if (mt) opts.mimeType = mt;
        }
        mr = new MediaRecorder(recStream, opts);
        mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        mr.onstart = () => { isRecording = true; postUp({ type: 'pm-dj-recording-started' }); };
        mr.onerror = (e) => postUp({ type: 'pm-dj-recording-error', error: e && (e.error || { message: String(e) }) });
        mr.onstop = () => {
          const type = (chunks[0] && chunks[0].type) || 'audio/webm';
          const blob = new Blob(chunks, { type });
          try { recStream && recStream.getTracks().forEach(t => t.stop()); } catch {}
          recStream = null; isRecording = false; mr = null; chunks = [];
          postUp({ type: 'pm-dj-recording-stopped', blob });
        };
        mr.start(200);
      } catch(e){}
    }

    function stopRec(){ try { if (mr && mr.state !== 'inactive') mr.stop(); } catch(e){}
    }

    // Relay messages from parent to inner and handle mic/recording here
    window.addEventListener('message', async (ev) => {
      const d = ev.data; if (!d || typeof d !== 'object') return;
      switch(d.type){
        case 'pm-dj-request-mic': await requestMicOnce(); break;
        case 'pm-dj-start-recording': await startRec(); break;
        case 'pm-dj-stop-recording': stopRec(); break;
        default:
          // Forward all other messages to inner app (theme, midi, etc.)
          postDown(d);
      }
    });

    // Relay all messages from inner up to parent unchanged so existing parent
    // code continues to work (midi inputs/state, any custom events)
    window.addEventListener('message', (ev) => {
      // If the message originated from the inner frame, bubble it up
      if (ev.source === inner.contentWindow) {
        postUp(ev.data);
      }
    });
  })();
  </script>
</body>
</html>`;
    return html;
  }, [midiAppUrl]);

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
                    try { iframeRef.current?.contentWindow?.postMessage({ type: 'midi:setShow', show }, '*'); } catch {}
                    if (show) {
                      try { iframeRef.current?.contentWindow?.postMessage({ type: 'midi:getInputs' }, '*'); } catch {}
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

              {/* Download button appears when a recording is available */}
              {recordingUrl && (
                <a
                  className="pill-button secondary"
                  href={recordingUrl}
                  download={`background-music-${Date.now()}.webm`}
                  title={t('backgroundMusic.downloadRecording', 'Download recording')}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>download</span>
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
                    <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>close</span>
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
          <span className="material-symbols-rounded">expand_more</span>
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
              srcDoc={wrapperHtml}
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
              <span className="material-symbols-rounded" style={{ fontSize: '28px' }}>restart_alt</span>
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
