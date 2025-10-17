/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import type { PlaybackState, Prompt } from '../types';
import type { AudioChunk, GoogleGenAI, LiveMusicFilteredPrompt, LiveMusicServerMessage, LiveMusicSession } from '@google/genai';
import { decode, decodeAudioData } from './audio';
import { throttle } from './throttle';

export class LiveMusicHelper extends EventTarget {

  private ai: GoogleGenAI;
  private model: string;

  private session: LiveMusicSession | null = null;
  private sessionPromise: Promise<LiveMusicSession> | null = null;

  private connectionError = true;

  private filteredPrompts = new Set<string>();
  private nextStartTime = 0;
  private bufferTime = 2;

  public readonly audioContext: AudioContext;
  public extraDestination: AudioNode | null = null;

  private outputNode: GainNode;
  private playbackState: PlaybackState = 'stopped';
  private loadingTimer: number | null = null;
  private bufferTimer: number | null = null;

  private prompts: Map<string, Prompt>;
  private sessionSeq: number = 0; // increments to invalidate stale callbacks

  constructor(ai: GoogleGenAI, model: string) {
    super();
    this.ai = ai;
    this.model = model;
    this.prompts = new Map();
    this.audioContext = new AudioContext({ sampleRate: 48000 });
    this.outputNode = this.audioContext.createGain();
  }

  // DEBUG
  private debug(...args: any[]) { try { console.log('[PDJ][Helper]', ...args); } catch {} }

  private getSession(): Promise<LiveMusicSession> {
    if (!this.sessionPromise) this.sessionPromise = this.connect();
    return this.sessionPromise;
  }

  private async connect(): Promise<LiveMusicSession> {
    // Bump sequence and capture for this connection to ignore stale callbacks on stop()
    const mySeq = ++this.sessionSeq;
    this.sessionPromise = this.ai.live.music.connect({
      model: this.model,
      callbacks: {
        onmessage: async (e: LiveMusicServerMessage) => {
          if (mySeq !== this.sessionSeq) { this.debug('onmessage ignored (stale seq)'); return; }
          this.debug('onmessage', {
            setupComplete: !!e.setupComplete,
            filteredPrompt: !!e.filteredPrompt,
            chunks: e.serverContent?.audioChunks?.length || 0,
          });
          if (e.setupComplete) {
            this.debug('setupComplete received');
            this.connectionError = false;
            if (this.loadingTimer) { clearTimeout(this.loadingTimer); this.loadingTimer = null; }
          }
          if (e.filteredPrompt) {
            this.debug('filteredPrompt received', e.filteredPrompt);
            this.filteredPrompts = new Set([...this.filteredPrompts, e.filteredPrompt.text!])
            this.dispatchEvent(new CustomEvent<LiveMusicFilteredPrompt>('filtered-prompt', { detail: e.filteredPrompt }));
          }
          if (e.serverContent?.audioChunks) {
            if (mySeq !== this.sessionSeq) { this.debug('audioChunks ignored (stale seq)'); return; }
            this.debug('audioChunks received', e.serverContent.audioChunks.length);
            if (this.loadingTimer) { clearTimeout(this.loadingTimer); this.loadingTimer = null; }
            await this.processAudioChunks(e.serverContent.audioChunks);
          }
        },
        onerror: () => {
          if (mySeq !== this.sessionSeq) { this.debug('onerror ignored (stale seq)'); return; }
          this.debug('onerror');
          this.connectionError = true;
          if (this.loadingTimer) { clearTimeout(this.loadingTimer); this.loadingTimer = null; }
          this.stop();
          this.dispatchEvent(new CustomEvent('error', { detail: 'Connection error, please restart audio.' }));
        },
        onclose: () => {
          if (mySeq !== this.sessionSeq) { this.debug('onclose ignored (stale seq)'); return; }
          this.debug('onclose');
          this.connectionError = true;
          if (this.loadingTimer) { clearTimeout(this.loadingTimer); this.loadingTimer = null; }
          this.stop();
          this.dispatchEvent(new CustomEvent('error', { detail: 'Connection error, please restart audio.' }));
        },
      },
    });
    return this.sessionPromise;
  }

  private setPlaybackState(state: PlaybackState) {
    this.debug('setPlaybackState ->', state);
    this.playbackState = state;
    this.dispatchEvent(new CustomEvent('playback-state-changed', { detail: state }));
  }

  private async processAudioChunks(audioChunks: AudioChunk[]) {
    // Only schedule when we're in playing or loading states; ignore if paused or stopped
    if (this.playbackState !== 'playing' && this.playbackState !== 'loading') {
      this.debug('processAudioChunks: early return due to state', this.playbackState);
      return;
    }

    const audioBuffer = await decodeAudioData(
      decode(audioChunks[0].data!),
      this.audioContext,
      48000,
      2,
    );
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.outputNode);

    const now = this.audioContext.currentTime;
    this.debug('processAudioChunks: now=', now.toFixed(3), 'nextStartTime=', this.nextStartTime.toFixed(3), 'bufDur=', audioBuffer.duration.toFixed(3));

    if (this.nextStartTime === 0) {
      this.nextStartTime = now + this.bufferTime;
      this.debug('processAudioChunks: scheduling first start at', this.nextStartTime.toFixed(3), 'bufferTime=', this.bufferTime);
      setTimeout(() => {
        this.debug('processAudioChunks: set playing after buffer');
        this.setPlaybackState('playing');
      }, this.bufferTime * 1000);
    }
    if (this.nextStartTime < now) {
      this.debug('processAudioChunks: fell behind, resetting to loading and rescheduling');
      this.setPlaybackState('loading');
      this.nextStartTime = 0;
      return;
    }
    try {
      source.start(this.nextStartTime);
      this.debug('processAudioChunks: scheduled source at', this.nextStartTime.toFixed(3));
    } catch (e) {
      this.debug('processAudioChunks: start() error', e);
    }
    this.nextStartTime += audioBuffer.duration;
  }

  public get activePrompts() {
    return Array.from(this.prompts.values())
      .filter((p) => {
        return !this.filteredPrompts.has(p.text) && p.weight !== 0;
      })
  }

  public readonly setWeightedPrompts = throttle(async (prompts: Map<string, Prompt>) => {
    this.prompts = prompts;

    if (this.activePrompts.length === 0) {
      this.dispatchEvent(new CustomEvent('error', { detail: 'There needs to be one active prompt to play.' }));
      this.pause();
      return;
    }

    // store the prompts to set later if we haven't connected yet
    // there should be a user interaction before calling setWeightedPrompts
    if (!this.session) return;

    try {
      await this.session.setWeightedPrompts({
        weightedPrompts: this.activePrompts.map(p => ({ text: p.text, weight: p.weight })),
      });
    } catch (e: any) {
      this.dispatchEvent(new CustomEvent('error', { detail: e.message }));
      this.pause();
    }
  }, 200);

  public async play() {
    this.debug('play() called');
    this.setPlaybackState('loading');
    // Start a safety timer: if no audio or setupComplete within 12s, abort and show error
    if (this.loadingTimer) { clearTimeout(this.loadingTimer); this.loadingTimer = null; }
    this.loadingTimer = (setTimeout(() => {
      this.loadingTimer = null;
      this.debug('play() timeout hit (no audio/setupComplete)');
      this.dispatchEvent(new CustomEvent('error', { detail: 'Starting audio timed out. Please check API key/network and try again.' }));
      this.pause();
    }, 12000) as unknown) as number;

    this.debug('play(): awaiting getSession()');
    this.session = await this.getSession();
    this.debug('play(): got session');
    this.debug('play(): setWeightedPrompts()');
    await this.setWeightedPrompts(this.prompts);
    this.debug('play(): audioContext.resume()');
    await this.audioContext.resume();
    this.debug('play(): session.play()');
    this.session.play();
    this.debug('play(): connect destinations');
    this.outputNode.connect(this.audioContext.destination);
    if (this.extraDestination) this.outputNode.connect(this.extraDestination);
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.1);
  }

  public pause() {
    if (this.session) this.session.pause();
    this.setPlaybackState('paused');
    this.outputNode.gain.setValueAtTime(1, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
    this.nextStartTime = 0;
    this.outputNode = this.audioContext.createGain();
  }

  public stop() {
    // Invalidate any in-flight callbacks from previous connection
    this.sessionSeq++;
    try { this.session?.stop(); } catch {}
    // Hard mute and disconnect
    try { this.outputNode.disconnect(); } catch {}
    this.outputNode = this.audioContext.createGain();
    this.nextStartTime = 0;
    this.setPlaybackState('stopped');
    this.session = null;
    this.sessionPromise = null;
    if (this.loadingTimer) { clearTimeout(this.loadingTimer); this.loadingTimer = null; }
  }

  public async playPause() {
    switch (this.playbackState) {
      case 'playing':
        return this.pause();
      case 'paused':
      case 'stopped':
        return this.play();
      case 'loading':
        return this.stop();
    }
  }

}
