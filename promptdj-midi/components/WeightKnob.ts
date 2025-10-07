/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

/** Maps prompt weight to halo size. */
const MIN_HALO_SCALE = 1;
const MAX_HALO_SCALE = 2;

/** The amount of scale to add to the halo based on audio level. */
const HALO_LEVEL_MODIFIER = 1;

/** A knob for adjusting and visualizing prompt weight. */
@customElement('weight-knob')
export class WeightKnob extends LitElement {
  static override styles = css`
    :host {
      cursor: grab;
      position: relative;
      width: 100%;
      aspect-ratio: 1;
      flex-shrink: 0;
      touch-action: none;
    }
    svg {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
    #halo {
      position: absolute;
      z-index: -1;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      mix-blend-mode: lighten;
      transform: scale(2);
      will-change: transform;
    }
    /* Improve halo contrast in light theme */
    :host-context([data-theme="light"]) #halo {
      mix-blend-mode: multiply;
      opacity: 0.55;
      filter: saturate(1.15) contrast(1.05);
    }
  `;

  @property({ type: Number }) value = 0;
  @property({ type: String }) color = '#000';
  @property({ type: Number }) audioLevel = 0;

  private dragStartPos = 0;
  private dragStartValue = 0;

  constructor() {
    super();
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
  }

  private handlePointerDown(e: PointerEvent) {
    e.preventDefault();
    this.dragStartPos = e.clientY;
    this.dragStartValue = this.value;
    document.body.classList.add('dragging');
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
  }

  private handlePointerMove(e: PointerEvent) {
    const delta = this.dragStartPos - e.clientY;
    this.value = this.dragStartValue + delta * 0.01;
    this.value = Math.max(0, Math.min(2, this.value));
    this.dispatchEvent(new CustomEvent<number>('input', { detail: this.value }));
  }

  private handlePointerUp() {
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    document.body.classList.remove('dragging');
  }

  private handleWheel(e: WheelEvent) {
    const delta = e.deltaY;
    this.value = this.value + delta * -0.0025;
    this.value = Math.max(0, Math.min(2, this.value));
    this.dispatchEvent(new CustomEvent<number>('input', { detail: this.value }));
  }

  private describeArc(
    centerX: number,
    centerY: number,
    startAngle: number,
    endAngle: number,
    radius: number,
  ): string {
    const startX = centerX + radius * Math.cos(startAngle);
    const startY = centerY + radius * Math.sin(startAngle);
    const endX = centerX + radius * Math.cos(endAngle);
    const endY = centerY + radius * Math.sin(endAngle);

    const largeArcFlag = endAngle - startAngle <= Math.PI ? '0' : '1';

    return (
      `M ${startX} ${startY}` +
      `A ${radius} ${radius} 0 ${largeArcFlag} 1 ${endX} ${endY}`
    );
  }

  override render() {
    const rotationRange = Math.PI * 2 * 0.75;
    const minRot = -rotationRange / 2 - Math.PI / 2;
    const maxRot = rotationRange / 2 - Math.PI / 2;
    const rot = minRot + (this.value / 2) * (maxRot - minRot);
    const dotStyle = styleMap({
      transform: `translate(40px, 40px) rotate(${rot}rad)`,
    });

    let scale = (this.value / 2) * (MAX_HALO_SCALE - MIN_HALO_SCALE);
    scale += MIN_HALO_SCALE;
    scale += this.audioLevel * HALO_LEVEL_MODIFIER;


    const haloStyle = styleMap({
      display: this.value > 0 ? 'block' : 'none',
      background: this.color,
      transform: `scale(${scale})`,
    });

    return html`
      <div id="halo" style=${haloStyle}></div>
      <!-- Static SVG elements -->
      ${this.renderStaticSvg()}
      <!-- SVG elements that move, separated to limit redraws -->
      <svg
        viewBox="0 0 80 80"
        @pointerdown=${this.handlePointerDown}
        @wheel=${this.handleWheel}>
        <g style=${dotStyle}>
          <circle cx="14" cy="0" r="2" fill="#000" />
        </g>
        <path
          d=${this.describeArc(40, 40, minRot, maxRot, 34.5)}
          fill="none"
          stroke="#0003"
          stroke-width="3"
          stroke-linecap="round" />
        <path
          d=${this.describeArc(40, 40, minRot, rot, 34.5)}
          fill="none"
          stroke="#fff"
          stroke-width="3"
          stroke-linecap="round" />
      </svg>
    `;
  }
  
  private renderStaticSvg() { 
    return html`<svg viewBox="0 0 80 80">
        <ellipse
          opacity="0.4"
          cx="40"
          cy="40"
          rx="40"
          ry="40"
          fill="url(#f1)" />
        <g filter="url(#f2)">
          <ellipse cx="40" cy="40" rx="29" ry="29" fill="url(#f3)" />
        </g>
        <g filter="url(#f4)">
          <circle cx="40" cy="40" r="20.6667" fill="url(#f5)" />
        </g>
        <circle cx="40" cy="40" r="18" fill="url(#f6)" />
        <defs>
          <filter
            id="f2"
            x="8.33301"
            y="10.0488"
            width="63.333"
            height="64"
            filterUnits="userSpaceOnUse"
            color-interpolation-filters="sRGB">
            <feFlood flood-opacity="0" result="BackgroundImageFix" />
            <feColorMatrix
              in="SourceAlpha"
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
              result="hardAlpha" />
            <feOffset dy="2" />
            <feGaussianBlur stdDeviation="1.5" />
            <feComposite in2="hardAlpha" operator="out" />
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
            <feBlend mode="normal" in2="BackgroundImageFix" result="shadow1" />
            <feBlend
              mode="normal"
              in="SourceGraphic"
              in2="shadow1"
              result="shape" />
          </filter>
          <filter
            id="f4"
            x="11.333"
            y="19.0488"
            width="57.333"
            height="59.334"
            filterUnits="userSpaceOnUse"
            color-interpolation-filters="sRGB">
            <feFlood flood-opacity="0" result="BackgroundImageFix" />
            <feColorMatrix
              in="SourceAlpha"
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
              result="hardAlpha" />
            <feOffset dy="10" />
            <feGaussianBlur stdDeviation="4" />
            <feComposite in2="hardAlpha" operator="out" />
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
            <feBlend mode="normal" in2="BackgroundImageFix" result="shadow1" />
            <feColorMatrix
              in="SourceAlpha"
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
              result="hardAlpha" />
            <feMorphology
              radius="5"
              operator="erode"
              in="SourceAlpha"
              result="shadow2" />
            <feOffset dy="8" />
            <feGaussianBlur stdDeviation="3" />
            <feComposite in2="hardAlpha" operator="out" />
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
            <feBlend mode="normal" in2="shadow1" result="shadow2" />
            <feBlend
              mode="normal"
              in="SourceGraphic"
              in2="shadow2"
              result="shape" />
          </filter>
          <linearGradient
            id="f1"
            x1="40"
            y1="0"
            x2="40"
            y2="80"
            gradientUnits="userSpaceOnUse">
            <stop stop-opacity="0.5" />
            <stop offset="1" stop-color="white" stop-opacity="0.3" />
          </linearGradient>
          <radialGradient
            id="f3"
            cx="0"
            cy="0"
            r="1"
            gradientUnits="userSpaceOnUse"
            gradientTransform="translate(40 40) rotate(90) scale(29 29)">
            <stop offset="0.6" stop-color="white" />
            <stop offset="1" stop-color="white" stop-opacity="0.7" />
          </radialGradient>
          <linearGradient
            id="f5"
            x1="40"
            y1="19.0488"
            x2="40"
            y2="60.3822"
            gradientUnits="userSpaceOnUse">
            <stop stop-color="white" />
            <stop offset="1" stop-color="#F2F2F2" />
          </linearGradient>
          <linearGradient
            id="f6"
            x1="40"
            y1="21.7148"
            x2="40"
            y2="57.7148"
            gradientUnits="userSpaceOnUse">
            <stop stop-color="#EBEBEB" />
            <stop offset="1" stop-color="white" />
          </linearGradient>
        </defs>
      </svg>`
  }

}

declare global {
  interface HTMLElementTagNameMap {
    'weight-knob': WeightKnob;
  }
}
