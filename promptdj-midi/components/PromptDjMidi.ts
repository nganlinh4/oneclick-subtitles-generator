/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { css, html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

import { throttle } from '../utils/throttle';

import './PromptController';
import './PlayPauseMorphWrapper';
import type { PlaybackState, Prompt } from '../types';
import { MidiDispatcher } from '../utils/MidiDispatcher';

/** The grid of prompt inputs. */
@customElement('prompt-dj-midi')
export class PromptDjMidi extends LitElement {
  static override styles = css`
    :host {
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      box-sizing: border-box;
      position: relative;
    }
    #background {
      will-change: background-image;
      position: absolute;
      height: 100%;
      width: 100%;
      z-index: -1;
      background: var(--md-surface);
    }
    /* Main layout: grid on the left, controls on the right */
    #content {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8vmin;
      position: relative;
    }

    /* Grid wrapper includes left add column and the 4x4 grid */
    #gridWrap {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 2.5vmin;
      height: 80vmin;
    }

    #addColumn {
      display: grid;
      grid-template-rows: repeat(4, 1fr);
      gap: 2.5vmin;
      height: 80vmin;
    }

    .add-slot {
      width: 17vmin;
      height: 12vmin;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      cursor: pointer;
    }
    .add-slot .add-icon {
      width: 9vmin;
      height: 9vmin;
      color: #fff;
      filter: drop-shadow(0 12px 22px rgba(0,0,0,0.25)) drop-shadow(0 4px 10px rgba(0,0,0,0.18));
      transition: transform var(--md-duration-short3) var(--md-easing-emphasized);
    }
    :host([data-theme="light"]) .add-slot .add-icon { color: #fff; }
    .add-slot:hover .add-icon { transform: scale(1.05); }

    #grid {
      width: 80vmin;
      height: 80vmin;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 2.5vmin;
    }
    .pc-wrap {
      position: relative;
      overflow: visible;
    }
    .pc-clear {
      position: absolute;
      top: -0.8vmin;
      right: -0.8vmin;
      width: 3.2vmin;
      height: 3.2vmin;
      border-radius: 9999px;
      border: 1px solid var(--md-outline-variant);
      background: var(--md-surface);
      color: var(--md-on-surface);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: var(--md-elevation-level1);
      opacity: 0;
      z-index: 20;
      pointer-events: auto;
      transition: opacity var(--md-duration-short3) var(--md-easing-standard),
                  transform var(--md-duration-short3) var(--md-easing-standard);
      transform: scale(0.9);
    }
    .pc-wrap:hover .pc-clear { opacity: 1; transform: scale(1); }

    #sideControls {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 80vmin;
    }
    play-pause-morph {
      width: 23vmin;
      height: 23vmin;
      display: inline-block;
    }


  `;

  private prompts: Map<string, Prompt>;
  private midiDispatcher: MidiDispatcher;

  @property({ type: Boolean }) private showMidi = false;
  @property({ type: String }) public playbackState: PlaybackState = 'stopped';
  @property({ type: String }) public lang: string = 'en';
  @state() public audioLevel = 0;
  private lastUserAction: 'play' | 'pause' | null = null;

  @state() private midiInputIds: string[] = [];
  @state() private activeMidiInputId: string | null = null;
  @state() private optimisticLoading: boolean = false;
  @state() private optimisticPlaying: boolean | null = null; // null = follow real state
  private clickCooldownUntil: number = 0; // epoch ms; during this window, ignore extra toggles

  // Left add-column activation state (4 slots)
  @state() private addSlotsActive: boolean[] = [false, false, false, false];
  // Track which base grid slots are removed (to render add buttons in-grid)
  @state() private removedSlots: Set<string> = new Set();

  @property({ type: Object })
  private filteredPrompts = new Set<string>();

  private basePrompts: Map<string, Prompt>;
  private baseOrder: string[] = [];

  constructor(
    initialPrompts: Map<string, Prompt>,
  ) {
    super();
    // Deep-copy base prompts so we can reset later
    this.basePrompts = new Map<string, Prompt>();
    for (const [k, p] of initialPrompts.entries()) {
      this.basePrompts.set(k, { ...p });
      this.baseOrder.push(k);
    }
    this.prompts = new Map(this.basePrompts);
    this.midiDispatcher = new MidiDispatcher();
  }

  private handlePromptChanged(e: CustomEvent<Prompt>) {
    const { promptId, text, weight, cc } = e.detail;
    const prompt = this.prompts.get(promptId);

    if (!prompt) {
      console.error('prompt not found', promptId);
      return;
    }

    prompt.text = text;
    prompt.weight = weight;
    prompt.cc = cc;

    const newPrompts = new Map(this.prompts);
    newPrompts.set(promptId, prompt);

    this.prompts = newPrompts;
    this.requestUpdate();

    this.dispatchEvent(
      new CustomEvent('prompts-changed', { detail: this.prompts }),
    );
  }

  /** Generates radial gradients for each prompt based on weight and color. */
  private readonly makeBackground = throttle(
    () => {
      const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

      const MAX_WEIGHT = 0.5;
      const MAX_ALPHA = 0.6;

      const bg: string[] = [];

      [...this.prompts.values()].forEach((p, i) => {
        const alphaPct = clamp01(p.weight / MAX_WEIGHT) * MAX_ALPHA;
        const alpha = Math.round(alphaPct * 0xff)
          .toString(16)
          .padStart(2, '0');

        const stop = p.weight / 2;
        const x = (i % 4) / 3;
        const y = Math.floor(i / 4) / 3;
        const s = `radial-gradient(circle at ${x * 100}% ${y * 100}%, ${p.color}${alpha} 0px, ${p.color}00 ${stop * 100}%)`;

        bg.push(s);
      });

      return bg.join(', ');
    },
    30, // don't re-render more than once every XXms
  );

  public async setShowMidi(show: boolean) {
    this.showMidi = show;
    if (!this.showMidi) return;
    try {
      const inputIds = await this.midiDispatcher.getMidiAccess();
      this.midiInputIds = inputIds;
      this.activeMidiInputId = this.midiDispatcher.activeMidiInputId;
      // Notify listeners (iframe bridge) that inputs are available/updated
      this.dispatchEvent(new CustomEvent('midi-inputs-changed', { detail: { inputs: this.midiInputIds, activeId: this.activeMidiInputId }}));
    } catch (e) {
      this.showMidi = false;
      this.dispatchEvent(new CustomEvent('error', {detail: (e as any).message}));
    }
  }

  // Public API used by parent (main app) via postMessage bridge
  public getShowMidi(): boolean { return this.showMidi; }
  public async refreshMidiInputs(): Promise<void> {
    try {
      const inputIds = await this.midiDispatcher.getMidiAccess();
      this.midiInputIds = inputIds;
      this.activeMidiInputId = this.midiDispatcher.activeMidiInputId;
      this.dispatchEvent(new CustomEvent('midi-inputs-changed', { detail: { inputs: this.midiInputIds, activeId: this.activeMidiInputId }}));
    } catch (e) {
      this.dispatchEvent(new CustomEvent('error', {detail: (e as any).message}));
    }
  }
  public getMidiInputs(): string[] { return this.midiInputIds; }
  public getActiveMidiInputId(): string | null { return this.activeMidiInputId; }
  public setActiveMidiInputId(id: string) {
    if (!id) return;
    this.activeMidiInputId = id;
    this.midiDispatcher.activeMidiInputId = id;
    this.dispatchEvent(new CustomEvent('midi-inputs-changed', { detail: { inputs: this.midiInputIds, activeId: this.activeMidiInputId }}));
    this.requestUpdate();
  }

  // Localized placeholder text
  private trPlaceholder(): string {
    const dict: Record<string, string> = {
      en: 'Type a sound prompt',
      ko: '사운드 프롬프트를 입력하세요',
      vi: 'Nhập prompt âm thanh',
    };
    const lc = (this.lang || 'en').toLowerCase();
    if (lc.startsWith('ko')) return dict.ko;
    if (lc.startsWith('vi')) return dict.vi;
    return dict.en;
  }

  private playPause(e: Event) {
    // Prevent the bubbling play-pause event from also reaching outer listeners
    e.stopPropagation();

    // Debounce rapid clicks to avoid double toggles
    const now = Date.now();
    if (now < this.clickCooldownUntil) return;
    this.clickCooldownUntil = now + 500;

    const morphEl = this.renderRoot?.querySelector('play-pause-morph') as HTMLElement | null;

    // If currently playing or loading: this click means STOP
    if (this.playbackState === 'playing' || this.playbackState === 'loading') {
      this.lastUserAction = 'pause';
      this.optimisticPlaying = false; // pause -> play morph immediately
      this.optimisticLoading = false; // ensure spinner is off
      morphEl?.removeAttribute('loading');
      morphEl?.setAttribute('playing', 'false');
      this.dispatchEvent(new CustomEvent('pause', { bubbles: true })); // explicit pause/stop
      return;
    }

    // If paused/stopped: this click means PLAY
    this.lastUserAction = 'play';
    this.optimisticLoading = true; // show spinner immediately
    this.optimisticPlaying = null; // follow real state for icon
    morphEl?.setAttribute('loading', '');
    this.dispatchEvent(new CustomEvent('play', { bubbles: true }));
  }

  public addFilteredPrompt(prompt: string) {
    this.filteredPrompts = new Set([...this.filteredPrompts, prompt]);
  }

  public setPromptLabels(labels: string[]) {
    const updated = new Map<string, Prompt>();
    let i = 0;
    for (const [key, p] of this.prompts.entries()) {
      const newText = labels[i] ?? p.text;
      updated.set(key, { ...p, text: newText });
      i++;
    }
    this.prompts = updated;
    this.requestUpdate();
    this.dispatchEvent(new CustomEvent('prompts-changed', { detail: this.prompts }));
  }

  public getPrompts(): Map<string, Prompt> {
    return new Map(this.prompts);
  }

  private addExtraSlot(idx: number) {
    const promptId = `extra-${idx}`;
    if (this.prompts.has(promptId)) return;
    const color = ['#9900ff', '#2af6de', '#ff25f6', '#ffdd28'][idx % 4];
    const p: Prompt = { promptId, text: this.trPlaceholder(), weight: 0, cc: 100 + idx, color };
    const updated = new Map(this.prompts);
    updated.set(promptId, p);
    this.prompts = updated;
    const slots = [...this.addSlotsActive];
    slots[idx] = true;
    this.addSlotsActive = slots;
    this.requestUpdate();
  }

  private addBaseSlot(idx: number) {
    const id = this.baseOrder[idx];
    if (!id || this.prompts.has(id)) return;
    const base = this.basePrompts.get(id);
    if (!base) return;
    const updated = new Map(this.prompts);
    updated.set(id, { ...base });
    this.prompts = updated;
    const rem = new Set(this.removedSlots);
    rem.delete(id);
    this.removedSlots = rem;
    this.requestUpdate();
  }

  private clearPrompt(promptId: string) {
    if (!this.prompts.has(promptId)) return;
    if (promptId.startsWith('extra-')) {
      // Remove extra prompt and deactivate slot
      const idx = Number(promptId.split('-')[1] || 0);
      const updated = new Map(this.prompts);
      updated.delete(promptId);
      this.prompts = updated;
      const slots = [...this.addSlotsActive];
      if (!Number.isNaN(idx)) slots[idx] = false;
      this.addSlotsActive = slots;
      this.requestUpdate();
      return;
    }
    // Remove built-in prompt and mark slot as removed to render add button in-grid
    const updated = new Map(this.prompts);
    updated.delete(promptId);
    this.prompts = updated;
    const rem = new Set(this.removedSlots);
    rem.add(promptId);
    this.removedSlots = rem;
    this.requestUpdate();
  }

  private resetAll() {
    // Reset to original base prompts and deactivate extra slots and removed slots
    this.prompts = new Map(this.basePrompts);
    this.addSlotsActive = [false, false, false, false];
    this.removedSlots = new Set();
    this.requestUpdate();
    this.dispatchEvent(new CustomEvent('prompts-changed', { detail: this.prompts }));
  }

  protected updated(changedProps: Map<string, any>) {
    if (changedProps.has('playbackState')) {
      const state = this.playbackState;
      if (this.lastUserAction === 'play') {
        if (state === 'playing') {
          this.optimisticLoading = false;
          this.optimisticPlaying = null;
          this.lastUserAction = null;
        } else if (state === 'loading') {
          this.optimisticLoading = true;
        } else if (state === 'paused' || state === 'stopped') {
          this.optimisticLoading = true;
        }
      } else if (this.lastUserAction === 'pause') {
        this.optimisticLoading = false;
        this.optimisticPlaying = false;
        if (state === 'paused' || state === 'stopped') {
          this.lastUserAction = null;
        }
      } else {
        this.optimisticLoading = (state === 'loading');
        this.optimisticPlaying = null;
      }
    }
  }

  override render() {
    const bg = styleMap({
      backgroundImage: this.makeBackground(),
    });
    const playingProp = this.optimisticPlaying !== null
      ? this.optimisticPlaying
      : (this.playbackState === 'playing');
    const loadingProp = this.optimisticLoading || this.playbackState === 'loading';

    return html`<div id="background" style=${bg}></div>
      <div id="content">
        <div id="gridWrap">
          <div id="addColumn">
            ${[0,1,2,3].map((idx) => this.addSlotsActive[idx]
              ? this.renderPromptWithClear(`extra-${idx}`)
              : html`<button class="add-slot" @click=${() => this.addExtraSlot(idx)} title="Add">
                  <svg class="add-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor"><path d="M412-412H222q-29 0-48.5-20.2T154-480q0-29 19.5-48.5T222-548h190v-191q0-27.6 20.2-47.8Q452.4-807 480-807q27.6 0 47.8 20.2Q548-766.6 548-739v191h190q29 0 48.5 19.5t19.5 48q0 28.5-19.5 48.5T738-412H548v190q0 27.6-20.2 47.8Q507.6-154 480-154q-27.6 0-47.8-20.2Q412-194.4 412-222v-190Z"/></svg>
                </button>`
            )}
          </div>
          <div id="grid">${this.renderPrompts()}</div>
        </div>
        <div id="sideControls">
          <play-pause-morph
            ?playing=${playingProp}
            ?loading=${loadingProp}
            @play-pause=${this.playPause}
          ></play-pause-morph>
        </div>
      </div>`;
  }

  private renderPromptWithClear(promptId: string) {
    const p = this.prompts.get(promptId);
    if (!p) return html``;
    return html`<div class="pc-wrap">
      <button class="pc-clear" title="Clear" @click=${() => this.clearPrompt(promptId)}>
        <!-- X icon -->
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <prompt-controller
        promptId=${p.promptId}
        ?filtered=${this.filteredPrompts.has(p.text)}
        cc=${p.cc}
        text=${p.text}
        weight=${p.weight}
        color=${p.color}
        .midiDispatcher=${this.midiDispatcher}
        .showCC=${this.showMidi}
        audioLevel=${this.audioLevel}
        @prompt-changed=${this.handlePromptChanged}
      ></prompt-controller>
    </div>`;
  }

  private renderPrompts() {
    const nodes: any[] = [];
    // Render in base grid order, allowing removed slots to show an add button
    this.baseOrder.forEach((id, idx) => {
      const p = this.prompts.get(id);
      if (!p || this.removedSlots.has(id)) {
        nodes.push(html`<button class="add-slot" @click=${() => this.addBaseSlot(idx)} title="Add">
          <svg class="add-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor"><path d="M412-412H222q-29 0-48.5-20.2T154-480q0-29 19.5-48.5T222-548h190v-191q0-27.6 20.2-47.8Q452.4-807 480-807q27.6 0 47.8 20.2Q548-766.6 548-739v191h190q29 0 48.5 19.5t19.5 48q0 28.5-19.5 48.5T738-412H548v190q0 27.6-20.2 47.8Q507.6-154 480-154q-27.6 0-47.8-20.2Q412-194.4 412-222v-190Z"/></svg>
        </button>`);
      } else {
        nodes.push(this.renderPromptWithClear(id));
      }
    });
    return nodes;
  }
}
