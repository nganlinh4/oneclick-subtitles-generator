/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { PlaybackState, Prompt } from '../types';
import { decodeAudioData } from './audio';
import { throttle } from './throttle';

export type NativePlaybackControl = 'play' | 'pause' | 'stop' | 'resetContext';

export interface NativeLiveMusicTransport {
  start(weightedPrompts: ReadonlyArray<{ text: string; weight: number }>): void;
  update(weightedPrompts: ReadonlyArray<{ text: string; weight: number }>): void;
  control(control: NativePlaybackControl): void;
  close(): void;
}

export type NativeLiveMusicEvent =
  | { event: 'ready' }
  | { event: 'controlApplied'; control: 'PLAY' | 'PAUSE' | 'STOP' | 'RESET_CONTEXT' }
  | { event: 'filteredPrompt'; text: string; reason: string }
  | { event: 'warning'; message: string }
  | { event: 'closed' }
  | { event: 'failed'; error: { code: string; message: string } };

export class LiveMusicHelper extends EventTarget {
  private readonly transport: NativeLiveMusicTransport;
  private sessionActive = false;
  private filteredPrompts = new Set<string>();
  private nextStartTime = 0;
  private readonly bufferTime = 2;
  public readonly audioContext: AudioContext;
  public extraDestination: AudioNode | null = null;
  private outputNode: GainNode;
  private playbackState: PlaybackState = 'stopped';
  private loadingTimer: number | null = null;
  private prompts = new Map<string, Prompt>();

  constructor(transport: NativeLiveMusicTransport) {
    super();
    this.transport = transport;
    this.audioContext = new AudioContext({ sampleRate: 48_000 });
    this.outputNode = this.audioContext.createGain();
  }

  private setPlaybackState(state: PlaybackState) {
    this.playbackState = state;
    this.dispatchEvent(new CustomEvent('playback-state-changed', { detail: state }));
  }

  public handleNativeEvent(event: NativeLiveMusicEvent) {
    switch (event.event) {
      case 'ready':
        this.sessionActive = true;
        if (this.loadingTimer) {
          clearTimeout(this.loadingTimer);
          this.loadingTimer = null;
        }
        break;
      case 'controlApplied':
        if (event.control === 'PAUSE') this.setPlaybackState('paused');
        if (event.control === 'STOP') this.resetPlayback('stopped');
        break;
      case 'filteredPrompt':
        this.filteredPrompts.add(event.text);
        this.dispatchEvent(new CustomEvent('filtered-prompt', {
          detail: { text: event.text, filteredReason: event.reason },
        }));
        break;
      case 'warning':
        this.dispatchEvent(new CustomEvent('error', { detail: event.message }));
        break;
      case 'closed':
        this.sessionActive = false;
        this.resetPlayback('stopped');
        break;
      case 'failed':
        this.sessionActive = false;
        this.resetPlayback('stopped');
        this.dispatchEvent(new CustomEvent('error', { detail: event.error.message }));
        break;
    }
  }

  public async handlePcm(pcm: ArrayBuffer) {
    if (this.playbackState !== 'playing' && this.playbackState !== 'loading') return;
    if (pcm.byteLength < 4 || pcm.byteLength > 512 * 1024 || pcm.byteLength % 4 !== 0) {
      this.dispatchEvent(new CustomEvent('error', { detail: 'The live music audio stream is invalid.' }));
      this.stop();
      return;
    }

    const audioBuffer = await decodeAudioData(
      new Uint8Array(pcm),
      this.audioContext,
      48_000,
      2,
    );
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.outputNode);
    const now = this.audioContext.currentTime;
    if (this.nextStartTime === 0) {
      this.nextStartTime = now + this.bufferTime;
      window.setTimeout(() => {
        if (this.playbackState === 'loading') this.setPlaybackState('playing');
      }, this.bufferTime * 1000);
    }
    if (this.nextStartTime < now) {
      this.setPlaybackState('loading');
      this.nextStartTime = 0;
      return;
    }
    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
  }

  public get activePrompts() {
    return Array.from(this.prompts.values()).filter((prompt) => (
      !this.filteredPrompts.has(prompt.text) && prompt.weight !== 0
    ));
  }

  private weightedPrompts() {
    return this.activePrompts.map(({ text, weight }) => ({ text, weight }));
  }

  public readonly setWeightedPrompts = throttle((prompts: Map<string, Prompt>) => {
    this.prompts = prompts;
    if (this.activePrompts.length === 0) {
      this.dispatchEvent(new CustomEvent('error', { detail: 'There needs to be one active prompt to play.' }));
      this.pause();
      return;
    }
    if (this.sessionActive) this.transport.update(this.weightedPrompts());
  }, 200);

  public async play() {
    if (this.activePrompts.length === 0) {
      this.dispatchEvent(new CustomEvent('error', { detail: 'There needs to be one active prompt to play.' }));
      this.setPlaybackState('stopped');
      return;
    }
    this.setPlaybackState('loading');
    if (this.loadingTimer) clearTimeout(this.loadingTimer);
    this.loadingTimer = window.setTimeout(() => {
      this.loadingTimer = null;
      this.dispatchEvent(new CustomEvent('error', {
        detail: 'Starting audio timed out. Please check API key/network and try again.',
      }));
      this.stop();
    }, 12_000);
    await this.audioContext.resume();
    this.outputNode.connect(this.audioContext.destination);
    if (this.extraDestination) this.outputNode.connect(this.extraDestination);
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.1);
    this.transport.start(this.weightedPrompts());
  }

  public pause() {
    if (this.sessionActive) this.transport.control('pause');
    this.setPlaybackState('paused');
    this.outputNode.gain.setValueAtTime(1, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
    this.nextStartTime = 0;
    this.outputNode = this.audioContext.createGain();
  }

  public stop() {
    if (this.sessionActive) this.transport.control('stop');
    this.transport.close();
    this.sessionActive = false;
    this.resetPlayback('stopped');
  }

  private resetPlayback(state: PlaybackState) {
    try { this.outputNode.disconnect(); } catch {}
    this.outputNode = this.audioContext.createGain();
    this.nextStartTime = 0;
    this.setPlaybackState(state);
    if (this.loadingTimer) {
      clearTimeout(this.loadingTimer);
      this.loadingTimer = null;
    }
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
