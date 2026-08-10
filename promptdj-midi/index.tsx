/**
 * @fileoverview Control real time music with a MIDI controller
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PlaybackState, Prompt } from './types';
import { PromptDjMidi } from './components/PromptDjMidi';
import { ToastMessage } from './components/ToastMessage';
import {
  LiveMusicHelper,
  type NativeLiveMusicEvent,
  type NativeLiveMusicTransport,
} from './utils/LiveMusicHelper';
import { AudioAnalyser } from './utils/AudioAnalyser';

const parentOrigin = window.location.origin;
const MAX_PCM_BYTES = 512 * 1024;
const MAX_PROMPTS = 16;

let teeNode: GainNode | null = null;
let mediaDest: MediaStreamAudioDestinationNode | null = null;
let mediaRecorder: MediaRecorder | null = null;

function postParent(message: object, transfer: Transferable[] = []) {
  const host = window.top;
  if (!host || host === window) return;
  host.postMessage(message, parentOrigin, transfer);
}

function validPromptPayload(value: unknown): value is Array<{ text: string; weight: number }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROMPTS) return false;
  let totalCharacters = 0;
  return value.every((prompt) => {
    if (prompt === null || typeof prompt !== 'object') return false;
    const record = prompt as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'text' && key !== 'weight')
        || typeof record.text !== 'string'
        || record.text.trim().length === 0
        || typeof record.weight !== 'number'
        || !Number.isFinite(record.weight)
        || record.weight <= 0
        || record.weight > 2) return false;
    const characters = Array.from(record.text).length;
    totalCharacters += characters;
    return characters <= 512 && totalCharacters <= 4_096;
  });
}

const nativeTransport: NativeLiveMusicTransport = {
  start(weightedPrompts) {
    if (!validPromptPayload(weightedPrompts)) return;
    postParent({ type: 'pm-dj-native-start', weightedPrompts });
  },
  update(weightedPrompts) {
    if (!validPromptPayload(weightedPrompts)) return;
    postParent({ type: 'pm-dj-native-update', weightedPrompts });
  },
  control(control) {
    if (!['play', 'pause', 'stop', 'resetContext'].includes(control)) return;
    postParent({ type: 'pm-dj-native-control', control });
  },
  close() {
    postParent({ type: 'pm-dj-native-close' });
  },
};

function isNativeEvent(value: unknown): value is NativeLiveMusicEvent {
  if (value === null || typeof value !== 'object' || typeof (value as { event?: unknown }).event !== 'string') {
    return false;
  }
  const event = value as Record<string, unknown>;
  switch (event.event) {
    case 'ready':
    case 'closed':
      return true;
    case 'controlApplied':
      return typeof event.control === 'string'
        && ['PLAY', 'PAUSE', 'STOP', 'RESET_CONTEXT'].includes(event.control);
    case 'filteredPrompt':
      return typeof event.text === 'string' && typeof event.reason === 'string';
    case 'warning':
      return typeof event.message === 'string';
    case 'failed':
      return event.error !== null
        && typeof event.error === 'object'
        && typeof (event.error as { code?: unknown }).code === 'string'
        && typeof (event.error as { message?: unknown }).message === 'string';
    default:
      return false;
  }
}

function main() {
  const initialPrompts = buildInitialPrompts();
  try { document.documentElement.setAttribute('data-theme', 'light'); } catch {}

  const pdjMidi = new PromptDjMidi(initialPrompts);
  document.body.appendChild(pdjMidi);
  const toastMessage = new ToastMessage();
  document.body.appendChild(toastMessage);

  const liveMusicHelper = new LiveMusicHelper(nativeTransport);
  liveMusicHelper.setWeightedPrompts(initialPrompts);
  const audioAnalyser = new AudioAnalyser(liveMusicHelper.audioContext);
  teeNode = liveMusicHelper.audioContext.createGain();
  teeNode.connect(audioAnalyser.node);
  liveMusicHelper.extraDestination = teeNode;
  let nativeAvailable = false;

  pdjMidi.addEventListener('prompts-changed', ((event: Event) => {
    const prompts = (event as CustomEvent<Map<string, Prompt>>).detail;
    liveMusicHelper.setWeightedPrompts(prompts);
  }));

  pdjMidi.addEventListener('error', ((event: Event) => {
    toastMessage.show((event as CustomEvent<string>).detail);
  }));

  pdjMidi.addEventListener('play', () => {
    if (!nativeAvailable) {
      toastMessage.show('Please set your Gemini API key in the main app first.');
      pdjMidi.playbackState = 'stopped';
      return;
    }
    liveMusicHelper.play().catch(() => {
      toastMessage.show('The native live music service is unavailable.');
      pdjMidi.playbackState = 'stopped';
    });
  });
  pdjMidi.addEventListener('pause', () => {
    if (!nativeAvailable) {
      toastMessage.show('Please set your Gemini API key in the main app first.');
      pdjMidi.playbackState = 'stopped';
      return;
    }
    liveMusicHelper.stop();
  });
  pdjMidi.addEventListener('play-pause', () => {
    if (!nativeAvailable) {
      toastMessage.show('Please set your Gemini API key in the main app first.');
      pdjMidi.playbackState = 'stopped';
      return;
    }
    liveMusicHelper.playPause().catch(() => {
      toastMessage.show('The native live music service is unavailable.');
    });
  });

  liveMusicHelper.addEventListener('playback-state-changed', ((event: Event) => {
    const playbackState = (event as CustomEvent<PlaybackState>).detail;
    pdjMidi.playbackState = playbackState;
    playbackState === 'playing' ? audioAnalyser.start() : audioAnalyser.stop();
  }));
  liveMusicHelper.addEventListener('filtered-prompt', ((event: Event) => {
    const filtered = (event as CustomEvent<{ text: string; filteredReason: string }>).detail;
    toastMessage.show(filtered.filteredReason);
    pdjMidi.addFilteredPrompt(filtered.text);
  }));
  liveMusicHelper.addEventListener('error', ((event: Event) => {
    toastMessage.show((event as CustomEvent<string>).detail);
  }));
  audioAnalyser.addEventListener('audio-level-changed', ((event: Event) => {
    pdjMidi.audioLevel = (event as CustomEvent<number>).detail;
  }));

  function startRecording() {
    try {
      if (!teeNode) return;
      if (mediaRecorder && mediaRecorder.state !== 'inactive') return;
      const destination = liveMusicHelper.audioContext.createMediaStreamDestination();
      teeNode.connect(destination);
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(destination.stream, { mimeType: mime });
      const chunks: BlobPart[] = [];
      mediaDest = destination;
      mediaRecorder = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        try { teeNode?.disconnect(destination); } catch {}
        if (mediaDest === destination) mediaDest = null;
        if (mediaRecorder === recorder) mediaRecorder = null;
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        postParent({ type: 'pm-dj-recording-stopped', blob });
      };
      recorder.onerror = () => {
        postParent({ type: 'pm-dj-recording-error', error: 'Recording could not be completed.' });
      };
      recorder.start(250);
      postParent({ type: 'pm-dj-recording-started' });
    } catch {
      postParent({ type: 'pm-dj-recording-error', error: 'Recording could not be started.' });
    }
  }

  function stopRecording() {
    try {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    } catch {
      postParent({ type: 'pm-dj-recording-error', error: 'Recording could not be stopped.' });
    }
  }

  function normalizeLang(lang: string | undefined): 'en' | 'ko' | 'vi' {
    const normalized = (lang || 'en').toLowerCase();
    if (normalized.startsWith('ko')) return 'ko';
    if (normalized.startsWith('vi')) return 'vi';
    return 'en';
  }

  pdjMidi.addEventListener('midi-inputs-changed', (event: Event) => {
    const { inputs, activeId } = (event as CustomEvent).detail || {};
    const named = (inputs || []).slice(0, 64).map((id: string) => ({
      id,
      name: (pdjMidi as any).midiDispatcher?.getDeviceName?.(id) || id,
    }));
    postParent({ type: 'midi:inputs', inputs: named, activeId, show: (pdjMidi as any).showMidi });
  });

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    const data = event.data as Record<string, unknown>;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

    if (data.type === 'pm-dj-native-init' && typeof data.available === 'boolean') {
      nativeAvailable = data.available;
      pdjMidi.credentialAvailable = nativeAvailable;
      if (!nativeAvailable) liveMusicHelper.stop();
    }
    if (data.type === 'pm-dj-native-event' && isNativeEvent(data.payload)) {
      liveMusicHelper.handleNativeEvent(data.payload);
    }
    if (data.type === 'pm-dj-native-audio'
        && data.pcm instanceof ArrayBuffer
        && data.pcm.byteLength >= 4
        && data.pcm.byteLength <= MAX_PCM_BYTES
        && data.pcm.byteLength % 4 === 0) {
      liveMusicHelper.handlePcm(data.pcm).catch(() => {
        toastMessage.show('The live music audio stream is invalid.');
        liveMusicHelper.stop();
      });
    }
    if (data.type === 'pm-dj-start-recording') startRecording();
    if (data.type === 'pm-dj-stop-recording') stopRecording();
    if (data.type === 'pm-dj-set-lang' && typeof data.lang === 'string') {
      pdjMidi.lang = normalizeLang(data.lang);
    }
    if (data.type === 'pm-dj-set-theme' && typeof data.theme === 'string') {
      try { document.documentElement.setAttribute('data-theme', data.theme === 'dark' ? 'dark' : 'light'); } catch {}
    }
    if (data.type === 'pm-dj-set-font' && typeof data.font === 'string') {
      const root = document.documentElement;
      let primary = `"Google Sans", "Open Sans", sans-serif`;
      let title = `"Google Sans", "Be Vietnam Pro", sans-serif`;
      if (data.font === 'product-sans') {
        primary = `"Product Sans", system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        title = primary;
      } else if (data.font === 'system-ui') {
        primary = `system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif`;
        title = primary;
      } else if (data.font === 'noto-sans') {
        primary = `"Noto Sans", "Open Sans", sans-serif`;
        title = primary;
      }
      root.style.setProperty('--font-primary', primary);
      root.style.setProperty('--font-title', title);
    }
    if (data.type === 'midi:getInputs') {
      (pdjMidi as any).refreshMidiInputs?.();
      const ids = ((pdjMidi as any).getMidiInputs?.() || []).slice(0, 64);
      const activeId = (pdjMidi as any).getActiveMidiInputId?.() || null;
      const named = ids.map((id: string) => ({
        id,
        name: (pdjMidi as any).midiDispatcher?.getDeviceName?.(id) || id,
      }));
      postParent({ type: 'midi:inputs', inputs: named, activeId, show: (pdjMidi as any).getShowMidi?.() });
    }
    if (data.type === 'midi:setShow' && typeof data.show === 'boolean') {
      (pdjMidi as any).setShowMidi?.(data.show);
    }
    if (data.type === 'midi:setActiveInput' && typeof data.id === 'string' && data.id.length <= 512) {
      (pdjMidi as any).setActiveMidiInputId?.(data.id);
    }
    if (data.type === 'pm-dj-reset') pdjMidi.resetAll();
  });
}

function buildInitialPrompts() {
  const startOn = [...DEFAULT_PROMPTS].sort(() => Math.random() - 0.5).slice(0, 3);
  const prompts = new Map<string, Prompt>();
  for (let index = 0; index < DEFAULT_PROMPTS.length; index += 1) {
    const promptId = `prompt-${index}`;
    const prompt = DEFAULT_PROMPTS[index];
    prompts.set(promptId, {
      promptId,
      text: prompt.text,
      weight: startOn.includes(prompt) ? 1 : 0,
      cc: index,
      color: prompt.color,
    });
  }
  return prompts;
}

const DEFAULT_PROMPTS = [
  { color: '#9900ff', text: 'Bossa Nova' },
  { color: '#5200ff', text: 'Chillwave' },
  { color: '#ff25f6', text: 'Drum and Bass' },
  { color: '#2af6de', text: 'Post Punk' },
  { color: '#ffdd28', text: 'Shoegaze' },
  { color: '#2af6de', text: 'Funk' },
  { color: '#9900ff', text: 'Chiptune' },
  { color: '#3dffab', text: 'Lush Strings' },
  { color: '#d8ff3e', text: 'Sparkling Arpeggios' },
  { color: '#d9b2ff', text: 'Staccato Rhythms' },
  { color: '#3dffab', text: 'Punchy Kick' },
  { color: '#ffdd28', text: 'Dubstep' },
  { color: '#ff25f6', text: 'K Pop' },
  { color: '#d8ff3e', text: 'Neo Soul' },
  { color: '#5200ff', text: 'Trip Hop' },
  { color: '#d9b2ff', text: 'Thrash' },
];

main();
