/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

@customElement('toast-message')
export class ToastMessage extends LitElement {
  static override styles = css`
    .toast {
      position: fixed;
      left: 50%;
      bottom: 24px;
      transform: translate(-50%, 16px);
      opacity: 0;

      display: inline-flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      max-width: min(520px, 88vw);

      border-radius: 16px;
      border: 1px solid var(--md-outline-variant);
      background: color-mix(in srgb, var(--md-surface), transparent 0%);
      color: var(--md-on-surface);
      box-shadow: var(--md-elevation-level3);
      backdrop-filter: blur(6px);

      line-height: 1.5;
      text-wrap: pretty;
      z-index: 999999;
      transition: transform var(--md-duration-medium3) var(--md-easing-emphasized),
                  opacity var(--md-duration-medium3) var(--md-easing-emphasized),
                  box-shadow var(--md-duration-short4) var(--md-easing-standard);
    }

    .toast.showing {
      transform: translate(-50%, 0);
      opacity: 1;
      box-shadow: var(--md-elevation-level4);
    }

    .message {
      flex: 1 1 auto;
      color: var(--md-on-surface);
    }

    button {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 9999px;
      border: 1px solid var(--md-outline-variant);
      background: var(--md-primary-container);
      color: var(--md-on-primary-container);
      cursor: pointer;
      transition: box-shadow var(--md-duration-short3) var(--md-easing-standard),
                  background-color var(--md-duration-short3) var(--md-easing-standard);
    }

    button:hover { box-shadow: var(--md-elevation-level1); }
    button:active { box-shadow: var(--md-elevation-level0, none); }

    a {
      color: var(--md-primary);
      text-decoration: underline;
    }
  `;

  @property({ type: String }) message = '';
  @property({ type: Boolean }) showing = false;

  private renderMessageWithLinks() {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = this.message.split( urlRegex );
    return parts.map( ( part, i ) => {
      if ( i % 2 === 0 ) return part;
      return html`<a href=${part} target="_blank" rel="noopener">${part}</a>`;
    } );
  }

  override render() {
    return html`<div class=${classMap({ showing: this.showing, toast: true })}>
      <div class="message">${this.renderMessageWithLinks()}</div>
      <button @click=${this.hide}>✕</button>
    </div>`;
  }

  show(message: string) {
    this.showing = true;
    this.message = message;
  }

  hide() {
    this.showing = false;
  }

}

declare global {
  interface HTMLElementTagNameMap {
    'toast-message': ToastMessage
  }
}
