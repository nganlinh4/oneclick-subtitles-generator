/**
 * @fileoverview Control real time music with a MIDI controller
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PlaybackState, Prompt } from './types';
import { GoogleGenAI, LiveMusicFilteredPrompt } from '@google/genai';
import { PromptDjMidi } from './components/PromptDjMidi';
import { ToastMessage } from './components/ToastMessage';
import { LiveMusicHelper } from './utils/LiveMusicHelper';
import { AudioAnalyser } from './utils/AudioAnalyser';

let ai: GoogleGenAI | null = null;
// Temporary debug logging
console.log('[PDJ] index.tsx loaded');
const model = 'lyria-realtime-exp';

// Recorder plumbing shared across message handlers
let teeNode: GainNode | null = null;
let mediaDest: MediaStreamAudioDestinationNode | null = null;
let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: BlobPart[] = [];

// Lazy-initialized helper and analyser (created after API key is provided by parent)
let liveMusicHelper: LiveMusicHelper | null = null;
let audioAnalyser: AudioAnalyser | null = null;


function main() {
  console.log('[PDJ] main() start');
  const initialPrompts = buildInitialPrompts();

  // Default to light theme unless parent tells us otherwise
  try { document.documentElement.setAttribute('data-theme', 'light'); } catch {}

  const pdjMidi = new PromptDjMidi(initialPrompts);
  document.body.appendChild(pdjMidi);
  console.log('[PDJ] <prompt-dj-midi> attached');

  const toastMessage = new ToastMessage();
  document.body.appendChild(toastMessage);
  console.log('[PDJ] <toast-message> attached');

  // Wire UI events regardless of helper init timing
  pdjMidi.addEventListener('prompts-changed', ((e: Event) => {
    const customEvent = e as CustomEvent<Map<string, Prompt>>;
    const prompts = customEvent.detail;
    liveMusicHelper?.setWeightedPrompts(prompts);
  }));

  // New explicit play/pause events to avoid accidental re-toggles
  pdjMidi.addEventListener('play', () => {
    liveMusicHelper?.play();
  });
  pdjMidi.addEventListener('pause', () => {
    // Use stop() to fully stop and prevent stray chunks from re-triggering
    liveMusicHelper?.stop();
  });
  // Back-compat: if any 'play-pause' is emitted, map based on current state
  pdjMidi.addEventListener('play-pause', () => {
    if (!liveMusicHelper) return;
    const stateMsg = '[PDJ] back-compat play-pause used; mapping to explicit action';
    try { console.log(stateMsg); } catch {}
    // Best-effort mapping: if not playing, play; else stop
    // This minimizes chance of spurious re-plays
    liveMusicHelper?.play?.();
  });

  const attachHelperListeners = () => {
    if (!liveMusicHelper) return;

    liveMusicHelper.addEventListener('playback-state-changed', ((e: Event) => {
      const customEvent = e as CustomEvent<PlaybackState>;
      const playbackState = customEvent.detail;
      pdjMidi.playbackState = playbackState;
      if (audioAnalyser) {
        playbackState === 'playing' ? audioAnalyser.start() : audioAnalyser.stop();
      }
    }));

    liveMusicHelper.addEventListener('filtered-prompt', ((e: Event) => {
      const customEvent = e as CustomEvent<LiveMusicFilteredPrompt>;
      const filteredPrompt = customEvent.detail;
      toastMessage.show(filteredPrompt.filteredReason!)
      pdjMidi.addFilteredPrompt(filteredPrompt.text!);
    }));

    liveMusicHelper.addEventListener('error', ((e: Event) => {
      const customEvent = e as CustomEvent<string>;
      const error = customEvent.detail;
      toastMessage.show(error);
    }));
  };

  // Listen for analyser events if/when created
  const attachAnalyserListener = () => {
    if (!audioAnalyser) return;
    audioAnalyser.addEventListener('audio-level-changed', ((e: Event) => {
      const customEvent = e as CustomEvent<number>;
      const level = customEvent.detail;
      pdjMidi.audioLevel = level;
    }));
  };

  function initWithApiKey(apiKey: string) {
    try {
      ai = new GoogleGenAI({ apiKey, apiVersion: 'v1alpha' });
      liveMusicHelper = new LiveMusicHelper(ai, model);
      liveMusicHelper.setWeightedPrompts(initialPrompts);
      audioAnalyser = new AudioAnalyser(liveMusicHelper.audioContext);
      // Create a tee node so we can fan out to analyser and (optionally) recorder
      teeNode = liveMusicHelper.audioContext.createGain();
      teeNode.connect(audioAnalyser.node);
      liveMusicHelper.extraDestination = teeNode;
      attachHelperListeners();
      attachAnalyserListener();
    } catch (e: any) {
      window.parent?.postMessage({ type: 'pm-dj-recording-error', error: e?.message || String(e) }, '*');
    }
  }

  // Expose recording controls via postMessage from parent iframe
  function startRecording() {
    try {
      if (!teeNode || !liveMusicHelper) return;
      if (mediaRecorder && mediaRecorder.state !== 'inactive') return;
      mediaDest = liveMusicHelper.audioContext.createMediaStreamDestination();
      teeNode.connect(mediaDest);
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      mediaRecorder = new MediaRecorder(mediaDest.stream, { mimeType: mime });
      recordedChunks = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunks.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        const blob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
        // Send blob back to parent to avoid cross-origin blob URL issues
        window.parent?.postMessage({ type: 'pm-dj-recording-stopped', blob }, '*');
      };
      mediaRecorder.start(250);
      window.parent?.postMessage({ type: 'pm-dj-recording-started' }, '*');
    } catch (e) {
      window.parent?.postMessage({ type: 'pm-dj-recording-error', error: (e as any)?.message || String(e) }, '*');
    }
  }

  function stopRecording() {
    try {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    } catch (e) {
      window.parent?.postMessage({ type: 'pm-dj-recording-error', error: (e as any)?.message || String(e) }, '*');
    }
  }

  function normalizeLang(lang: string | undefined): 'en' | 'ko' | 'vi' {
    const lc = (lang || 'en').toLowerCase();
    if (lc.startsWith('ko')) return 'ko';
    if (lc.startsWith('vi')) return 'vi';
    return 'en';
  }

  // Forward MIDI input updates to parent
  pdjMidi.addEventListener('midi-inputs-changed', (e: Event) => {
    const { inputs, activeId } = (e as CustomEvent).detail || {};
    // Map to include device names from dispatcher
    const named = (inputs || []).map((id: string) => ({ id, name: pdjMidi ? (pdjMidi as any).midiDispatcher?.getDeviceName?.(id) : id }));
    window.parent?.postMessage({ type: 'midi:inputs', inputs: named, activeId, show: (pdjMidi as any).showMidi }, '*');
  });

  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as any;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'pm-dj-start-recording') startRecording();
    if (data.type === 'pm-dj-stop-recording') stopRecording();
    if (data.type === 'pm-dj-set-api-key' && typeof data.apiKey === 'string' && data.apiKey) {
      if (data.lang && pdjMidi) {
        pdjMidi.lang = normalizeLang(data.lang);
      }
      initWithApiKey(data.apiKey);
    }
    if (data.type === 'pm-dj-set-lang' && pdjMidi) {
      pdjMidi.lang = normalizeLang(data.lang);
    }
    if (data.type === 'pm-dj-set-theme' && typeof data.theme === 'string') {
      try { document.documentElement.setAttribute('data-theme', data.theme === 'dark' ? 'dark' : 'light'); } catch {}
    }

    // Bridge: control MIDI from parent
    if (data.type === 'midi:getInputs') {
      (pdjMidi as any).refreshMidiInputs?.();
      // Also respond immediately with current snapshot
      const ids = (pdjMidi as any).getMidiInputs?.() || [];
      const activeId = (pdjMidi as any).getActiveMidiInputId?.() || null;
      const named = ids.map((id: string) => ({ id, name: (pdjMidi as any).midiDispatcher?.getDeviceName?.(id) || id }));
      window.parent?.postMessage({ type: 'midi:inputs', inputs: named, activeId, show: (pdjMidi as any).getShowMidi?.() }, '*');
    }
    if (data.type === 'midi:setShow') {
      (pdjMidi as any).setShowMidi?.(!!data.show);
    }
    if (data.type === 'midi:setActiveInput' && typeof data.id === 'string') {
      (pdjMidi as any).setActiveMidiInputId?.(data.id);
    }
    if (data.type === 'pm-dj-reset') {
      (pdjMidi as any).resetAll?.();
    }
  });

}

function buildInitialPrompts() {
  // Pick 3 random prompts to start at weight = 1
  const startOn = [...DEFAULT_PROMPTS]
    .sort(() => Math.random() - 0.5)
    .slice(0, 3);

  const prompts = new Map<string, Prompt>();

  for (let i = 0; i < DEFAULT_PROMPTS.length; i++) {
    const promptId = `prompt-${i}`;
    const prompt = DEFAULT_PROMPTS[i];
    const { text, color } = prompt;
    prompts.set(promptId, {
      promptId,
      text,
      weight: startOn.includes(prompt) ? 1 : 0,
      cc: i,
      color,
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
