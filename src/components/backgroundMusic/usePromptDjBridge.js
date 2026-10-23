// Window-message bridge from the PromptDJ iframe: validates each message and routes it to the
// newest handler. The listener is installed once per frame/origin, not on every handler change.
import { useEffect, useRef } from 'react';

const TOAST_TYPES = new Set(['info', 'error', 'success', 'warning']);
const MAX_TOAST_LENGTH = 4_096;
const MAX_MIDI_INPUTS = 64;
const MAX_MIDI_TEXT = 512;

const sanitizeMidiInputs = (inputs) => (Array.isArray(inputs)
  ? inputs.slice(0, MAX_MIDI_INPUTS).filter((input) => (
    input
    && typeof input === 'object'
    && typeof input.id === 'string'
    && input.id.length <= MAX_MIDI_TEXT
    && typeof input.name === 'string'
    && input.name.length <= MAX_MIDI_TEXT
  )).map(({ id, name }) => ({ id, name }))
  : []);

const recordToastHistory = (data) => {
  if (typeof data.message === 'string'
      && data.message.length > 0
      && data.message.length <= MAX_TOAST_LENGTH
      && TOAST_TYPES.has(data.toastType)) {
    window.recordToastHistory?.(data.message, data.toastType);
  }
};

const routeMessage = (data, handlers) => {
  switch (data.type) {
    case 'pm-dj-toast-history': recordToastHistory(data); break;
    case 'pm-dj-native-start': handlers.onNativeStart?.(data.weightedPrompts); break;
    case 'pm-dj-native-update': handlers.onNativeUpdate?.(data.weightedPrompts); break;
    case 'pm-dj-native-control': handlers.onNativeControl?.(data.control); break;
    case 'pm-dj-native-close': handlers.onNativeClose?.(); break;
    case 'pm-dj-recording-started': handlers.onRecordingStarted?.(); break;
    case 'pm-dj-recording-stopped': handlers.onRecordingStopped?.(data.blob); break;
    case 'pm-dj-recording-error': handlers.onRecordingError?.(); break;
    case 'midi:inputs':
      handlers.onMidiInputs?.({
        inputs: sanitizeMidiInputs(data.inputs),
        activeId: typeof data.activeId === 'string' && data.activeId.length <= MAX_MIDI_TEXT
          ? data.activeId
          : undefined,
        show: typeof data.show === 'boolean' ? data.show : undefined,
      });
      break;
    default: break;
  }
};

/**
 * @param {object} params
 * @param {() => Window|null} params.getPromptDjWindow the only accepted message source
 * @param {string} params.promptDjOrigin the only accepted message origin
 * @param {object} params.handlers onNativeStart/Update/Control/Close, onRecordingStarted/
 *   Stopped/Error and onMidiInputs; any may be omitted
 */
const usePromptDjBridge = ({ getPromptDjWindow, promptDjOrigin, handlers }) => {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onMessage = (event) => {
      if (event.source !== getPromptDjWindow() || event.origin !== promptDjOrigin) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
      routeMessage(data, handlersRef.current);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [getPromptDjWindow, promptDjOrigin]);
};

export default usePromptDjBridge;
