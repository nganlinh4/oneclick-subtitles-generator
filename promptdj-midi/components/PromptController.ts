/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { css, html, LitElement } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

import './WeightKnob';
import type { WeightKnob } from './WeightKnob';

import type { MidiDispatcher } from '../utils/MidiDispatcher';
import type { Prompt, ControlChange } from '../types';

/** A single prompt input associated with a MIDI CC. */
@customElement('prompt-controller')
export class PromptController extends LitElement {
  static override styles = css`
    @keyframes pulse-orange {
      0%,
      100% {
        box-shadow: 0 0 0.8vmin orange;
        transform: translateX(-50%) scale(1);
      }
      50% {
        box-shadow: 0 0 1.5vmin orange, 0 0 0.1vmin orange inset;
        transform: translateX(-50%) scale(1.05);
      }
    }

    .prompt {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      /* Establish a positioning context for the MIDI label */
      position: relative;
    }
    weight-knob {
      width: 70%;
      flex-shrink: 0;
      order: 2;
      cursor: ns-resize;
    }
    
    #midi {
      position: absolute;
      top: 1vmin;
      left: 50%;
      transform: translateX(-50%);
      z-index: 10;
      font-family: monospace;
      text-align: center;
      font-size: 1.5vmin;
      border-radius: 1.5vmin;
      padding: 2px 5px;
      color: #fff;
      background: #222;
      cursor: pointer;
      visibility: hidden;
      user-select: none;
      box-shadow: 0 0 0 0.1vmin #fff4;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    
    #midi:hover {
      transform: translateX(-50%) scale(1.1);
      box-shadow: 0 0 0.5vmin #fff;
    }
    
    .learn-mode #midi {
      color: orange;
      animation: pulse-orange 1.5s infinite;
    }
    
    .show-cc #midi {
      visibility: visible;
    }

    .text-wrapper {
      position: relative;
      width: 17vmin;
      height: 6vmin;
      margin-top: -7.5vmin;
      display: flex;
      align-items: center;
      justify-content: center;
      
      /* 
       * ==================================================================
       * THE FIX: This is the key change.
       * By setting pointer-events to 'none', this wrapper becomes 
       * transparent to mouse clicks, allowing them to pass through to the
       * weight-knob underneath it. The interactive children below will
       * re-enable pointer-events for themselves.
       * ==================================================================
       */
      pointer-events: none;
      order: 3;
    }

    #text-svg {
      width: 100%;
      height: 100%;
      overflow: visible;
      user-select: none;
      pointer-events: none; /* The SVG container itself is not interactive */
    }

    /* Default = dark-friendly (white text with black glow) */
    #text-svg text {
      font-weight: 500;
      font-size: 2.3vmin;
      fill: #fff;
      text-anchor: middle;
      -webkit-font-smoothing: antialiased;
      text-shadow: 0 0 0.5vmin #000, 0 0 0.5vmin #000;
      /* FIX: Re-enable pointer events for the text so it can be clicked */
      pointer-events: auto; 
      cursor: text;
      transition: transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275),
        text-shadow 0.2s ease-out, fill 0.2s ease-out;
      transform-origin: 50% 50%;
    }

    /* Light theme: black text with white shadows */
    :host-context([data-theme="light"]) #text-svg text {
      fill: #000;
      text-shadow: 0 0 0.6vmin #fff, 0 0 1.2vmin rgba(255,255,255,0.85);
    }

    .edit-icon {
      position: absolute;
      right: -2.5vmin;
      top: 1.5vmin;
      width: 2.2vmin;
      height: 2.2vmin;
      fill: #fff;
      filter: drop-shadow(0 0 0.3vmin #000);
      opacity: 0;
      transform: translateX(5px);
      transition: all 0.2s ease-out;
      pointer-events: none;
    }

    .is-hovering #text-svg text {
      transform: scale(1.2) translateY(-4px);
      text-shadow: 0 0 1.5vmin #fff, 0 0 0.5vmin #000;
    }

    .is-hovering .edit-icon {
      opacity: 1;
      transform: translateX(0);
    }

    #text {
      font-weight: 500;
      font-size: 2.2vmin;
      text-shadow: 0 0 0.8vmin #000, 0 0 0.2vmin #000;
      max-width: 17vmin;
      min-width: 2vmin;
      padding: 0.1em 0.3em;
      border-radius: 0.25vmin;
      text-align: center;
      white-space: pre;
      overflow: hidden;
      border: none;
      outline: none;
      -webkit-font-smoothing: antialiased;
      background: #000;
      color: #fff;
      position: absolute;
      visibility: hidden;
      z-index: 2;
      /* FIX: Re-enable pointer events for the input field so it can be focused */
      pointer-events: auto;
      cursor: text;

      &:not(:focus) {
        text-overflow: ellipsis;
      }
    }

    /* Keep arc text visible during editing so it looks curved */
    .is-editing .edit-icon {
      visibility: hidden;
    }
    .is-editing #text {
      visibility: visible;
      opacity: 0; /* capture input but keep visual on arc */
    }

    /* Make the arched text visually distinct during editing. */
    .is-editing #text-svg text {
      /* Retain the scale from the hover state to prevent a visual "jump". */
      transform: scale(1.2) translateY(-4px);
      /* Invert colors to make the editing mode highly visible. */
      fill: #000;
      text-shadow: 0 0 0.6vmin #fff, 0 0 1.2vmin rgba(255, 255, 255, 0.85);
    }

    /* Invert editing mode colors for the light theme too. */
    :host-context([data-theme='light']) .is-editing #text-svg text {
      fill: #fff;
      text-shadow: 0 0 0.5vmin #000, 0 0 0.5vmin #000;
    }

    :host([filtered]) {
      weight-knob {
        opacity: 0.5;
      }
      .text-wrapper {
        background: #da2000;
        border-radius: 0.25vmin;
        z-index: 1;
      }
      #text {
        background: transparent;
      }
    }

    @media only screen and (max-width: 600px) {
      #text,
      #text-svg text {
        font-size: 3.8vmin;
      }
      weight-knob {
        width: 60%;
      }
    }
  `;

  @property({ type: String }) promptId = '';
  @property({ type: String }) text = '';
  @property({ type: Number }) weight = 0;
  @property({ type: String }) color = '';
  @property({ type: Boolean, reflect: true }) filtered = false;

  @property({ type: Number }) cc = 0;
  @property({ type: Number }) channel = 0; // Not currently used

  @property({ type: Boolean }) learnMode = false;
  @property({ type: Boolean }) showCC = false;

  @query('weight-knob') private weightInput!: WeightKnob;
  @query('#text') private textInput!: HTMLSpanElement;

  @property({ type: Object })
  midiDispatcher: MidiDispatcher | null = null;

  @property({ type: Number }) audioLevel = 0;

  @state() private isEditing = false;
  @state() private isHovering = false;

  private lastValidText!: string;

  override connectedCallback() {
    super.connectedCallback();
    this.midiDispatcher?.addEventListener('cc-message', (e: Event) => {
      const customEvent = e as CustomEvent<ControlChange>;
      const { channel, cc, value } = customEvent.detail;
      if (this.learnMode) {
        this.cc = cc;
        this.channel = channel;
        this.learnMode = false;
        this.dispatchPromptChange();
      } else if (cc === this.cc) {
        this.weight = (value / 127) * 2;
        this.dispatchPromptChange();
      }
    });
  }

  override firstUpdated() {
    this.textInput.setAttribute('contenteditable', 'plaintext-only');
    this.textInput.textContent = this.text;
    this.lastValidText = this.text;

    const textEl = this.shadowRoot?.querySelector('#text-svg text');
    if (textEl) {
      textEl.addEventListener('mouseover', () => {
        this.isHovering = true;
      });
      textEl.addEventListener('mouseout', () => {
        this.isHovering = false;
      });
      textEl.addEventListener('click', () => this.startEditing());
    }
  }

  override update(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('showCC') && !this.showCC) {
      this.learnMode = false;
    }
    if (changedProperties.has('text') && this.textInput) {
      this.textInput.textContent = this.text;
    }
    super.update(changedProperties);
  }

  private dispatchPromptChange() {
    this.dispatchEvent(
      new CustomEvent<Prompt>('prompt-changed', {
        detail: {
          promptId: this.promptId,
          text: this.text,
          weight: this.weight,
          cc: this.cc,
          color: this.color,
        },
      })
    );
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.textInput.blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.resetText();
      this.textInput.blur();
    }
  }

  private onInlineInput() {
    // Live-update arc text while typing (span is invisible, arc shows)
    const newText = this.textInput.textContent ?? '';
    this.text = newText;
    // Do not commit lastValidText until stopEditing; but propagate for live behavior
    this.dispatchPromptChange();
  }

  private resetText() {
    this.text = this.lastValidText;
    this.textInput.textContent = this.lastValidText;
  }

  private async stopEditing() {
    this.isEditing = false;
    const newText = this.textInput.textContent?.trim();
    if (!newText) {
      this.resetText();
    } else {
      this.text = newText;
      this.lastValidText = newText;
    }
    this.dispatchPromptChange();
    this.textInput.scrollLeft = 0;
  }

  private onFocus() {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(this.textInput);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private startEditing() {
    if (this.isEditing) return;
    this.isEditing = true;
    this.updateComplete.then(() => {
      this.textInput.focus();
      this.onFocus();
    });
  }

  private updateWeight() {
    this.weight = this.weightInput.value;
    this.dispatchPromptChange();
  }

  private toggleLearnMode() {
    this.learnMode = !this.learnMode;
  }

  override render() {
    const promptClasses = classMap({
      prompt: true,
      'learn-mode': this.learnMode,
      'show-cc': this.showCC,
    });

    const textWrapperClasses = classMap({
      'text-wrapper': true,
      'is-editing': this.isEditing,
      'is-hovering': this.isHovering && !this.isEditing,
    });

    const editIconPath = html`<path
      d="M2.7 14.3l7.9-7.9 3.1 3.1-7.9 7.9-3.1-3.1z M15.5 2.5c-0.4-0.4-1-0.4-1.4 0l-1.4 1.4 3.1 3.1 1.4-1.4c0.4-0.4 0.4-1 0-1.4l-1.7-1.7z M1 17l1.9-5.6 3.1 3.1-5 2.5z"
    ></path>`;

    return html`<div class=${promptClasses}>
      <weight-knob
        id="weight"
        value=${this.weight}
        color=${this.filtered ? '#888' : this.color}
        audioLevel=${this.filtered ? 0 : this.audioLevel}
        @input=${this.updateWeight}
      ></weight-knob>

      <div class=${textWrapperClasses}>
        <svg id="text-svg" viewBox="-10 0 120 25">
          <path
            id="text-arc-path"
            d="M -10,20 A 60,45 0 0,0 110,20"
            fill="none"
            stroke="none"
          ></path>
          <text>
            <textPath href="#text-arc-path" startOffset="50%">
              ${this.text}
            </textPath>
          </text>
        </svg>

        <svg class="edit-icon" viewBox="0 0 18 18">${editIconPath}</svg>

        <span
          id="text"
          spellcheck="false"
          @input=${this.onInlineInput}
          @focus=${this.onFocus}
          @keydown=${this.onKeyDown}
          @blur=${this.stopEditing}
        ></span>
      </div>

      <div id="midi" @click=${this.toggleLearnMode}>
        ${this.learnMode ? 'Learn' : `CC:${this.cc}`}
      </div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'prompt-controller': PromptController;
  }
}