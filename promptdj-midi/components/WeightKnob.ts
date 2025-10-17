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

    :host(:active) {
      cursor: grabbing;
      filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.4))
              drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
      transform: translateY(1px);
    }

    svg {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      transition: transform 0.1s ease-out;
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
      filter: blur(8px);
      opacity: 0.8;
    }

    /* Improve halo contrast in light theme */
    :host-context([data-theme="light"]) #halo {
      mix-blend-mode: multiply;
      opacity: 0.55;
      filter: saturate(1.15) contrast(1.05) blur(8px);
    }

    /* Add subtle ambient lighting effect */
    :host::before {
      content: '';
      position: absolute;
      top: -10%;
      left: -10%;
      right: -10%;
      bottom: -10%;
      background: radial-gradient(
        ellipse at 30% 20%,
        rgba(255, 255, 255, 0.1) 0%,
        rgba(255, 255, 255, 0.05) 40%,
        transparent 70%
      );
      border-radius: 50%;
      pointer-events: none;
      z-index: 1;
    }
  `;

  @property({ type: Number }) value = 0;
  @property({ type: String }) color = '#000';
  @property({ type: Number }) audioLevel = 0;

  private dragStartPos = 0;
  private dragStartValue = 0;
  private activePointerId: number | null = null;
  private isDragging = false;

  constructor() {
    super();
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handlePointerCancel = this.handlePointerCancel.bind(this);
    this.onLostPointerCapture = this.onLostPointerCapture.bind(this);
    this.onWindowBlur = this.onWindowBlur.bind(this);
  }

  connectedCallback(): void {
    super.connectedCallback();
  }

  disconnectedCallback(): void {
    // Ensure we always cleanup listeners if the element is removed
    this.teardownDragListeners();
    super.disconnectedCallback();
  }

  private setupDragListeners() {
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerCancel);
    window.addEventListener('blur', this.onWindowBlur);
    // Fallback for mouse leaving the iframe without a pointerup firing
    window.addEventListener('mouseleave', this.handlePointerCancel as any);
    this.addEventListener('lostpointercapture', this.onLostPointerCapture);
  }

  private teardownDragListeners() {
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerCancel);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('mouseleave', this.handlePointerCancel as any);
    this.removeEventListener('lostpointercapture', this.onLostPointerCapture);
  }

  private handlePointerDown(e: PointerEvent) {
    e.preventDefault();
    this.dragStartPos = e.clientY;
    this.dragStartValue = this.value;
    this.activePointerId = e.pointerId;
    this.isDragging = true;
    document.body.classList.add('dragging');
    // Try to retain events even when pointer leaves the iframe/element
    try {
      (this as unknown as Element).setPointerCapture(e.pointerId);
    } catch {}
    this.setupDragListeners();
  }

  private handlePointerMove(e: PointerEvent) {
    if (!this.isDragging || (this.activePointerId !== null && e.pointerId !== this.activePointerId)) return;
    const delta = this.dragStartPos - e.clientY;
    this.value = this.dragStartValue + delta * 0.01;
    this.value = Math.max(0, Math.min(2, this.value));
    this.dispatchEvent(new CustomEvent<number>('input', { detail: this.value }));
  }

  private endDrag() {
    if (!this.isDragging) return;
    this.isDragging = false;
    if (this.activePointerId !== null) {
      try {
        (this as unknown as Element).releasePointerCapture(this.activePointerId);
      } catch {}
    }
    this.activePointerId = null;
    this.teardownDragListeners();
    document.body.classList.remove('dragging');
  }

  private handlePointerUp() {
    this.endDrag();
  }

  private handlePointerCancel() {
    this.endDrag();
  }

  private onLostPointerCapture() {
    // If we lose capture without a pointerup, end the drag to avoid sticky state
    this.endDrag();
  }

  private onWindowBlur() {
    // If iframe/window loses focus while dragging, end drag
    this.endDrag();
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
          <!-- Enhanced 3D indicator with depth -->
          <g filter="url(#indicatorShadow)">
            <rect x="5" y="-1.5" width="10" height="3" rx="1.5" fill="url(#indicatorGradient)" />
          </g>
          <!-- Highlight on top of indicator -->
          <rect x="5.5" y="-1" width="9" height="1" rx="0.5" fill="url(#indicatorHighlight)" opacity="0.8" />
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
        <!-- Outer shadow/base -->
        <ellipse
          opacity="0.6"
          cx="40"
          cy="42"
          rx="38"
          ry="38"
          fill="url(#baseShadow)" />

        <!-- Main knob body with enhanced depth -->
        <g filter="url(#mainShadow)">
          <ellipse cx="40" cy="40" rx="29" ry="29" fill="url(#knobBody)" />
        </g>

        <!-- Inner beveled ring -->
        <g filter="url(#innerShadow)">
          <circle cx="40" cy="40" r="20" fill="url(#innerRing)" stroke="url(#ringStroke)" stroke-width="0.5" />
        </g>

        <!-- Center knob surface -->
        <g filter="url(#centerShadow)">
          <circle cx="40" cy="40" r="16" fill="url(#centerSurface)" />
        </g>

        <!-- Top highlight -->
        <ellipse cx="40" cy="37" rx="14" ry="12" fill="url(#topHighlight)" opacity="0.8" />

        <!-- Subtle texture lines -->
        <g opacity="0.15" stroke="url(#textureStroke)" stroke-width="0.3">
          <circle cx="40" cy="40" r="26" fill="none" />
          <circle cx="40" cy="40" r="24" fill="none" />
          <circle cx="40" cy="40" r="20" fill="none" />
        </g>

        <defs>
          <!-- Enhanced shadow filters for 3D depth -->
          <filter id="mainShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
            <feOffset dx="0" dy="4" result="offset"/>
            <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.4 0"/>
            <feBlend in2="SourceGraphic" mode="normal"/>
          </filter>

          <filter id="innerShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
            <feOffset dx="0" dy="4" result="offset"/>
            <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0"/>
            <feBlend in2="SourceGraphic" mode="normal"/>
          </filter>

          <filter id="centerShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="1.5"/>
            <feOffset dx="0" dy="1" result="offset"/>
            <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.2 0"/>
            <feBlend in2="SourceGraphic" mode="normal"/>
          </filter>

          <!-- Inset shadow effect for depth -->
          <filter id="insetShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feOffset in="SourceAlpha" dx="0" dy="2"/>
            <feGaussianBlur stdDeviation="2" result="offset-blur"/>
            <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0" result="shadow"/>
            <feComposite in="SourceGraphic" in2="shadow" operator="over"/>
          </filter>
          <!-- Gradients for realistic materials and lighting -->
          <radialGradient id="baseShadow" cx="50%" cy="50%" r="50%">
            <stop offset="80%" stop-color="#000" stop-opacity="0.3" />
            <stop offset="100%" stop-color="#000" stop-opacity="0" />
          </radialGradient>

          <radialGradient id="knobBody" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="white" />
            <stop offset="100%" stop-color="white" stop-opacity="0.7" />
          </radialGradient>

          <linearGradient id="innerRing" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="white" />
            <stop offset="100%" stop-color="#F2F2F2" />
          </linearGradient>

          <linearGradient id="ringStroke" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#E0E0E0" />
            <stop offset="100%" stop-color="#C0C0C0" />
          </linearGradient>

          <linearGradient id="centerSurface" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#EBEBEB" />
            <stop offset="100%" stop-color="white" />
          </linearGradient>

          <radialGradient id="topHighlight" cx="30%" cy="30%" r="40%">
            <stop offset="0%" stop-color="white" stop-opacity="0.6" />
            <stop offset="70%" stop-color="white" stop-opacity="0.3" />
            <stop offset="100%" stop-color="white" stop-opacity="0" />
          </radialGradient>


          <filter id="indicatorShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="0.5"/>
            <feOffset dx="0" dy="0.5" result="offset"/>
            <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.6 0"/>
            <feBlend in2="SourceGraphic" mode="normal"/>
          </filter>

          <linearGradient id="indicatorGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#FF8C00" />
            <stop offset="100%" stop-color="#E07B00" />
          </linearGradient>

          <linearGradient id="indicatorHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.9" />
            <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0.7" />
          </linearGradient>

          <linearGradient id="textureStroke" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#fff" stop-opacity="0.1" />
            <stop offset="100%" stop-color="#000" stop-opacity="0.1" />
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
